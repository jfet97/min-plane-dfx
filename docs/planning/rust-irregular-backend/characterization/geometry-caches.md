# Characterization: geometry-caches

Stage 0 characterization for the Rust irregular-nesting port (Compact / Compact
Short Side). Cluster scope: the geometry-cache identity, storage, and access
layer — cache key construction, the synchronous backing store, the trusted-ring
fingerprint shortcut, and the transformed-collision resolver.

Files read completely for this document:

- `src/workers/irregular/core/nfpCacheKey.ts`
- `src/workers/irregular/core/geometryCacheIdentity.ts`
- `src/workers/irregular/core/geometryCacheStore.ts`
- `src/workers/irregular/geometryCacheKeys.ts`
- `src/workers/irregular/geometryCacheStoreLive.ts`
- `src/workers/irregular/core/transformCollisionGeometryCore.ts`
- `src/workers/irregular/transformCollisionGeometry.ts`

Files read in full or in relevant part as direct callers/callees needed to
ground every claim precisely (not the primary specification surface of this
cluster, but load-bearing for sections 2, 4, 9, 12, 14):

- `src/workers/irregular/core/nfpBoundaryCore.ts` (full)
- `src/workers/irregular/core/ifpBoundsCore.ts` (full)
- `src/workers/irregular/nfpIfpTelemetry.ts` (full)
- `src/workers/irregular/services.ts` (full)
- `src/workers/irregular/geometryKernel.ts` (full)
- `src/workers/irregular/internalGeometry.ts` (full)
- `src/workers/irregular/clipper2OffsetPolicy.ts` (full)
- `src/workers/irregular/convexPolygonValidation.ts` (full)
- `src/workers/irregular/core/convexHullCore.ts` (full)
- `src/workers/irregular/geometryPredicates.ts` (relevant part)
- `src/workers/irregular/nfpIfpService.ts` (read for caller context; its own
  candidate-generation algorithm belongs to a different cluster)
- `src/workers/nesting.worker.ts` (relevant part, production wiring)
- `src/workers/algorithm/irregular/computeIrregularNesting.ts` (grep-level,
  confirms single provide site for Compact and Compact Short Side)
- `docs/research/intrinsic-shared-archive-performance-checkpoint.md`
- `docs/research/trusted-ring-validation-memo.md`
- `docs/history/pure-core-boundary-decisions.md`
- `docs/artifacts/nfp-cache-effect-inventory/README.md` (grep-level)
- Tests: `tests/unit/irregularGeometryCache.test.ts`,
  `tests/unit/nfpBoundaryCore.test.ts`, `tests/unit/ifpTransformCore.test.ts`,
  `tests/unit/pureIfpTransformContract.test.ts`,
  `tests/unit/nfpBoundaryTrustedRings.test.ts`,
  `tests/unit/ringFingerprintAccessPath.test.ts`,
  `tests/unit/nfpIfpTelemetry.test.ts` (all read in full)

---

## 1. Purpose and role in Compact / Compact Short Side execution

This cluster is the identity and storage substrate for two of the three
worker-level geometry caches used by the live irregular pipeline:

- **Pairwise relative NFP cache** — namespace `pairwise-nfp-relative-v3`
  (`src/workers/irregular/core/nfpCacheKey.ts:4`). Keys and validates the
  relative (fixed-at-origin) outer no-fit-polygon boundary between two convex
  collision polygons under given transforms and geometry settings.
- **Transformed-collision-geometry cache** — namespace `transform-collision-v1`
  (`src/workers/irregular/core/geometryCacheIdentity.ts:13`). Keys and
  validates one mirror-then-rotate transform applied to one piece's collision
  polygon, snapped to the canonical collision grid.
- **Rectangular inner-fit-bounds (IFP) cache** — namespace `sheet-ifp-v1`
  (`src/workers/irregular/core/geometryCacheIdentity.ts:14`). Keys and
  validates the rectangular sheet-translation envelope for one moving piece.

(A fourth, adjacent cache — `legal-placement-candidates-v1`, the
per-decode-scope legal-candidate memo built in
`src/workers/irregular/geometryCacheKeys.ts:44-106` and consumed by a
`WeakMap` in `src/workers/irregular/nfpIfpService.ts:611-694` — is keyed using
helpers from this cluster's files but its consultation/caching control flow
lives in `nfpIfpService.ts`, which is a different cluster's primary subject.
It is documented here only to the extent its key-construction touches this
cluster's code.)

The backing store (`src/workers/irregular/core/geometryCacheStore.ts`,
`src/workers/irregular/geometryCacheStoreLive.ts`) is namespace-agnostic: one
`Map<string, unknown>` keyed by a JSON-serialized `[namespace, parts]` pair
holds all three (four, counting the legal-candidate memo, which uses its own
`Map` inside a `WeakMap`, not this store) cache families for one job.

**Live-on-production-path confirmation (traced, not assumed).** The only
production wiring point for the irregular worker is
`src/workers/nesting.worker.ts:377-397`, which builds
`computeIrregularNesting(request, options)` and provides
`Effect.provide(NfpIfpServiceLive)` (`nesting.worker.ts:393`) and
`Effect.provide(GeometryKernel.Live)` (`nesting.worker.ts:397`) exactly once
per worker request. `NfpIfpServiceLive` is
`makeNfpIfpServiceLive().pipe(Layer.provideMerge(GeometryCacheInMemory))`
(`src/workers/irregular/nfpIfpService.ts:85-94`), and
`GeometryKernel.Live = GeometryKernel.Layer =
Layer.effect(GeometryKernel, GeometryKernel.Make).pipe(Layer.provideMerge(GeometryCacheInMemory))`
(`src/workers/irregular/geometryKernel.ts:195-199`). `GeometryCacheInMemory` is
just `GeometryCacheLive` (`src/workers/irregular/services.ts:451`), a
`Layer.sync` that constructs one fresh `makeGeometryCacheStore()`
(`services.ts:436-448`, `src/workers/irregular/geometryCacheStoreLive.ts:9-30`).
Because `computeIrregularNesting.ts` is the single call site for both Compact
and Compact Short Side inside one worker request (`grep` confirms only
`nesting.worker.ts:377` calls it in production code, and Short Side
construction inside `computeIrregularNesting.ts:1149-1191` runs inside the
same `Effect.gen` composition, not under a nested `Effect.provide` of a new
`GeometryCache`), **all three caches in this cluster are live on the
production Compact and Compact Short Side path, and Compact and Short Side
share exactly one cache instance per worker job.** This matches the migration
prompt's principle "one nesting job owns a coherent cache domain" (prompt
§13.1) as *already-implemented* behavior, not a target to build.

Every module in the FILES-TO-READ list is reachable from that production wire:
`nfpCacheKey.ts` → `nfpBoundaryCore.ts` → `nfpIfpService.ts` → `NfpIfpServiceLive`;
`geometryCacheIdentity.ts` → both `nfpBoundaryCore`-adjacent `ifpBoundsCore.ts`
and `transformCollisionGeometryCore.ts` → `geometryKernel.ts` →
`GeometryKernel.Live`; `geometryCacheStore.ts` → `geometryCacheStoreLive.ts` →
`services.ts::GeometryCacheLive`; `geometryCacheKeys.ts` is a thin
re-export/adapter consumed by `nfpIfpService.ts` and by tests;
`transformCollisionGeometry.ts` is the Effect-service wrapper around
`computeTransformedCollisionGeometry` consumed by `geometryKernel.ts:19`. None
of these seven files is experimental, test-only, or dead. There is no
alternate/legacy cache implementation shadowing this one.

Performance context (not part of this cluster's code, but explains *why* it
exists): `docs/research/intrinsic-shared-archive-performance-checkpoint.md:88-92`
records that NFP generation is **not** the dominant Mixed-61 cost (candidate
generation ≈ 8.8 s vs. candidate-state scoring ≈ 144–147 s in one profiled
sample); the pairwise NFP cache's ~98% hit rate is what keeps NFP generation
off the critical path at all. `docs/research/trusted-ring-validation-memo.md:30-34`
records one Mixed-61 `2000x2700` gate run's cache telemetry: namespace
`pairwise-nfp-relative-v3` had `266977` lookups / `262166` present / `4811`
stores (98.2% present rate), and `transform-collision-v1` had `10028` lookups /
`9540` present / `488` stores. These numbers match the migration prompt's
§13.3 citation. A Rust port that recomputes on every "hit" (instead of reusing
an immutable published value) would be doing ~98% wasted geometry work on this
namespace.

## 2. Entry points, callers, callees

### `core/nfpCacheKey.ts`
- Exports: `NFP_GEOMETRY_CACHE_NAMESPACE`, `NFP_CONSTRUCTION_ALGORITHMS`,
  `DEFAULT_NFP_CONSTRUCTION_ALGORITHM`, types `CoreTransformCandidate`,
  `CoreGeometrySettings`, `PairwiseNfpKeyInput`, and function
  `makePairwiseNfpCacheKey` (`nfpCacheKey.ts:31-47`).
- Called by: `core/nfpBoundaryCore.ts:138-147` (`resolveNfpBoundary`) and
  `geometryCacheKeys.ts:55-69` (`pairwiseNfpCacheKey`, the public/testing
  adapter re-deriving the same key from the domain `ComputeNfpInput` shape).
- Callees: none beyond `Object.is`/`String` (pure).

### `core/geometryCacheIdentity.ts`
- Exports: `TRANSFORM_GEOMETRY_CACHE_NAMESPACE`, `IFP_GEOMETRY_CACHE_NAMESPACE`,
  types `TransformCollisionGeometryKeyInput`, `InnerFitBoundsKeyInput`,
  functions `makeTransformCollisionGeometryCacheKey` (`:34-48`),
  `makeInnerFitBoundsCacheKey` (`:51-62`), `boundsForPoints` (`:64-84`),
  `sameTransform` (`:86-96`), `isInternalPolygon` (`:143-146`).
- Called by:
  - `core/transformCollisionGeometryCore.ts:51` (key construction),
    `:124` (`sameTransform` inside `isValidCachedTransformedCollisionGeometry`),
    `:11` (`isInternalPolygon` import), `:10` (`boundsForPoints`).
  - `core/ifpBoundsCore.ts:9,45` (`boundsForPoints`, `makeInnerFitBoundsCacheKey`).
  - `geometryCacheKeys.ts:23-27` (both key-namespace constants and both
    `make*CacheKey` functions, re-exported/wrapped).
- Callees: none beyond `Math.min`/`Math.max`/`Number.isFinite` (pure).

### `core/geometryCacheStore.ts`
- Exports: interface `GeometryCacheKey` (`namespace`, `parts`), interface
  `GeometryCacheStore` (`get`/`set`/`remove`/`clear`), function
  `serializeGeometryCacheKey` (`:13-15`, `JSON.stringify([key.namespace, key.parts])`).
- Called by: `geometryCacheStoreLive.ts:5` (the only production `get`/`set`/
  `remove` implementation), `services.ts:21,416` (`cacheKeyToString`), and
  every core resolver (`nfpBoundaryCore.ts`, `ifpBoundsCore.ts`,
  `transformCollisionGeometryCore.ts`) via the `GeometryCacheStore` type.
- No callees (pure type/serialization module).

### `geometryCacheKeys.ts`
- Public adapter layer translating the pure-core key builders
  (`InternalPoint`/`InternalPolygon`-typed) into the domain-facing
  (`IrregularPoint`/`IrregularPolygon`, `@shared/irregular/domain.js`) shapes
  used by `nfpIfpService.ts` and by tests. Exports:
  `transformCollisionGeometryCacheKey`, `pairwiseNfpCacheKey`,
  `innerFitBoundsCacheKey`, `legalPlacementCandidateMemoKey`,
  `isValidCachedTransform`, `isValidCachedNfpBoundary`, `isValidCachedIfp`,
  plus re-exports of the namespace constants and construction-algorithm types.
- Called by: `nfpIfpService.ts:43-52` (imports `DEFAULT_NFP_CONSTRUCTION_ALGORITHM`,
  `legalPlacementCandidateMemoKey`, types), and by tests
  (`irregularGeometryCache.test.ts`, `pureIfpTransformContract.test.ts`) to
  compute expected cache keys independently of the resolvers under test.
- Note: `pairwiseNfpCacheKey`/`transformCollisionGeometryCacheKey`/
  `innerFitBoundsCacheKey` in this file are **not** used by the live
  request-serving path inside `nfpBoundaryCore.ts`/`transformCollisionGeometryCore.ts`/
  `ifpBoundsCore.ts` — those call the `core/*CacheKey`/`core/geometryCacheIdentity`
  builders directly with `Internal*`-typed data. `geometryCacheKeys.ts`'s
  wrappers are used for (a) `nfpIfpService.ts`'s `NfpConstructionAlgorithm`/
  namespace re-exports and the legal-candidate memo key, and (b) test-side key
  recomputation for assertions. Both code paths must produce byte-identical
  keys for the same logical input — this is a **duplication that a Rust port
  must either preserve as two call paths or intentionally collapse while
  proving byte-identical output**, see §15.

### `geometryCacheStoreLive.ts`
- Exports `makeGeometryCacheStore(): GeometryCacheStore` (`:9-30`), the sole
  production implementation.
- Called by: `services.ts:22,437` (`GeometryCacheLive`/`GeometryCacheInMemory`
  layer), which is the only production instantiation site (§1).
- Callees: `NfpIfpTelemetry.recordCacheInstance/recordCacheGet/recordCacheSet/recordCacheRemove`
  (`geometryCacheStoreLive.ts:6,11,15,20,24`), a no-import module
  (`nfpIfpTelemetry.ts:13`) safe to call unconditionally.

### `core/transformCollisionGeometryCore.ts`
- Exports: interfaces `CoreTransformCollisionSuccess/Failure/Result`,
  functions `resolveTransformedCollisionGeometry` (`:38-63`, cache-aware),
  `computeTransformedCollisionGeometry` (`:66-113`, pure, no cache),
  `isValidCachedTransformedCollisionGeometry` (`:115-137`).
- `resolveTransformedCollisionGeometry` called by
  `geometryKernel.ts:181-186` (`transformCollisionGeometry` service method,
  the live path) and directly by tests
  (`ifpTransformCore.test.ts:113-114`).
- `computeTransformedCollisionGeometry` called by
  `transformCollisionGeometry.ts:27` (the Effect-wrapped, cache-**bypassing**
  variant — see §9 for where this is/isn't on the cached path) and by
  `geometryCacheKeys.ts`'s test-facing helpers indirectly via
  `isValidCachedTransformedCollisionGeometry` (`geometryCacheKeys.ts:29,109-114`).
- Callees: `fromGrid`/`toGridMm` (`clipper2OffsetPolicy.ts:44-58`),
  `ConvexPolygonValidation.validateStrictBoundary`
  (`convexPolygonValidation.ts:60-116`), `boundsForPoints`/`isInternalPolygon`/
  `makeTransformCollisionGeometryCacheKey`/`sameTransform`
  (`geometryCacheIdentity.ts`), `Math.cos`/`Math.sin`/`Math.PI` for arbitrary
  rotation angles (`:169-171`).

### `transformCollisionGeometry.ts`
- Exports `TransformCollisionGeometry.compute` (`:15-32`), the Effect-service
  facade, and `toDomainTransformedCollisionGeometry` (`:35-48`), the
  `Internal*` → domain-class adapter reused by `geometryKernel.ts:19,185`.
- `TransformCollisionGeometry.compute` itself calls
  `computeTransformedCollisionGeometry` directly (**not**
  `resolveTransformedCollisionGeometry`), i.e. it is a cache-bypassing
  wrapper. Grep confirms `TransformCollisionGeometry` (the exported object) has
  no production callers outside its own test file — the live
  `GeometryKernel.transformCollisionGeometry` service method calls
  `resolveTransformedCollisionGeometry` directly in `geometryKernel.ts:181`,
  not through this facade. `TransformCollisionGeometry.compute` therefore
  appears to be a non-production (test/legacy-shape) entry point; confirm via
  `grep -rn "TransformCollisionGeometry\b" src tests` before deciding Rust
  needs to port it as anything other than a thin `computeTransformedCollisionGeometry`
  call (see §15, open question).

## 3. Data in/out: exact types/shapes, optional-field presence/omission semantics

### `GeometryCacheKey` (`core/geometryCacheStore.ts:1-4`)
```ts
interface GeometryCacheKey {
  readonly namespace: string
  readonly parts: ReadonlyArray<string>
}
```
No optional fields. `parts` order is semantically load-bearing (it is
serialized verbatim into the key string, §8).

### `GeometryCacheStore` (`core/geometryCacheStore.ts:6-11`)
```ts
interface GeometryCacheStore {
  readonly get: <A>(key: GeometryCacheKey) => A | undefined
  readonly set: <A>(key: GeometryCacheKey, value: A) => void
  readonly remove: (key: GeometryCacheKey) => void
  readonly clear: () => void
}
```
`get` returns `A | undefined`; `undefined` means "absent", not "present with
value undefined" — `Map.get` on a missing key returns `undefined` and nothing
in this cluster ever `set`s an explicit `undefined` value into the store
(every producer only calls `set` after successfully computing a concrete
value). A Rust port should model this as `Option<Arc<V>>` and must not
conflate "no entry" with "entry holding a semantically-empty value".

### `CoreTransformCandidate` / `InternalTransformCandidate` (`nfpCacheKey.ts:9-14`,
`internalGeometry.ts:22-27`)
```ts
{ index: number; rotationDeg: number; mirrored: boolean; reason: string }
```
All fields required (no optionals). `reason` is a free-text string baked
verbatim into the cache key (§6 — string equality, not semantic equality,
decides key collisions on `reason`).

### `CoreGeometrySettings` / `InternalGeometrySettings` (`nfpCacheKey.ts:16-21`,
`internalGeometry.ts:29-34`)
```ts
{
  flatteningSagToleranceMm: number
  clearanceSafetyMarginMm: number
  geometryBackendId: string
  geometryBackendVersion: string
}
```
All required. Two of the four fields (`geometryBackendId`,
`geometryBackendVersion`) are unused by geometry computation itself but are
baked into every cache key in this cluster (§8) — a backend upgrade
invalidates every cache entry by construction, without any explicit
versioning/eviction logic.

### `PairwiseNfpKeyInput` (`nfpCacheKey.ts:23-29`)
```ts
{
  fixedPolygon: ReadonlyArray<InternalPoint>
  movingPolygon: ReadonlyArray<InternalPoint>
  fixedTransform: CoreTransformCandidate
  movingTransform: CoreTransformCandidate
  settings: CoreGeometrySettings
}
```

### `TransformCollisionGeometryKeyInput<TPieceId, TTransform>` (`geometryCacheIdentity.ts:16-22`)
```ts
{
  geometry: InternalCollisionGeometry<TPieceId>
  transform: TTransform
}
```
`InternalCollisionGeometry` (`internalGeometry.ts:42-49`) carries
`sourcePieceId`, `sourceBounds`, `sampledPoints`, `convexHull`,
`collisionPolygon`, `placementReference` — but only `sourcePieceId`,
`sourceBounds`, `placementReference`, `convexHull.points`, and
`collisionPolygon.points` are folded into the cache key
(`collisionGeometryDigest`, `geometryCacheIdentity.ts:108-116`);
`sampledPoints` is **not** part of the key.

### `InnerFitBoundsKeyInput<TPieceId, TTransform, TSheet>` (`geometryCacheIdentity.ts:24-31`)
```ts
{
  sheet: TSheet   // { width, height, label }
  moving: InternalTransformedCollisionGeometry<TPieceId, TTransform>
}
```
`InternalTransformedCollisionGeometry` (`internalGeometry.ts:51-59`) carries
`sourcePieceId`, `transform`, `polygon`, `bounds` — only `sourcePieceId`,
`transform`, and `polygon.points` feed the IFP key
(`makeInnerFitBoundsCacheKey`, `geometryCacheIdentity.ts:54-61`); the cached
`.bounds` field is **not** part of the key and, per a doc comment in
`nfpIfpService.ts:213-218`, is explicitly distrusted at the IFP legality
boundary because it is "derived cache data" that a stale cache must not be
allowed to enlarge.

### Cache **values**
- `pairwise-nfp-relative-v3` → `InternalPolygon` (`{ points: InternalPoint[] }`),
  the **relative** (untranslated) NFP boundary — i.e. the cached value is
  independent of the fixed piece's placement translation
  (`nfpBoundaryCore.ts:148-163`); translation is applied post-lookup on every
  call (`translateNfpBoundary`, `:465-482`), never cached.
- `transform-collision-v1` → whatever `materialize()` produces
  (`transformCollisionGeometryCore.ts:47-49,60-62`); in production this is
  `toDomainTransformedCollisionGeometry` (`transformCollisionGeometry.ts:35-48`),
  a `TransformedCollisionGeometry` **domain class instance** (not a plain
  object) — the cache therefore stores domain-class instances for this
  namespace, unlike the NFP/IFP namespaces which store plain
  `Internal*`-shaped objects. A Rust port must preserve the semantic content,
  not the "is it a class instance" distinction, but should note this
  asymmetry so it does not accidentally assume all three namespaces store
  structurally-identical value kinds.
- `sheet-ifp-v1` → `InternalIfpBounds<TPieceId, TSheet>`
  (`{ sheet, movingPieceId, bounds }`, `internalGeometry.ts:61-68`).

### Optional-field presence/omission
None of the seven cluster files define Effect `Schema.optional` fields or rely
on `undefined`-omission semantics in JSON — `serializeGeometryCacheKey` uses
plain `JSON.stringify` on a `[string, string[]]` tuple where every element is
always a required, always-present `string`. There is no `BigInt` anywhere in
this cluster. (`undefined`-omission and `BigInt` are relevant to *other*
clusters — canonical checkpoint/state-key encoders — not this one.)

## 4. Algorithm state and every mutation point

State owned by this cluster, all **job-local** (constructed fresh per
`GeometryCacheLive` layer build, §1, §9):

1. **The backing `Map<string, unknown>`**
   (`geometryCacheStoreLive.ts:10`). Mutated only by `set` (insert/overwrite,
   `:18-21`), `remove` (delete, `:22-25`), `clear` (empty, `:26-28`). No other
   file in the repository reaches into this map directly; all mutation is
   through the four `GeometryCacheStore` methods.
2. **`validatedRings` `WeakMap<object, {fingerprint, validation}>`**
   (`core/nfpBoundaryCore.ts:31-37`), module-level (not job-scoped — see
   §12/§15 for the cross-job leakage analysis). Mutated by
   `validateStrictBoundaryOnce` (`:39-55`): `.set()` on a fresh/changed
   fingerprint (`:52`), `.delete()` when the ring can no longer produce a
   fingerprint (i.e., contains non-finite coordinates or `undefined` holes,
   `:49-51`). Never read anywhere except inside the same function.
3. **`NfpIfpTelemetry`'s module-level `state: MutableState | undefined`**
   (`nfpIfpTelemetry.ts:95`), process-global (not job-scoped, but disabled —
   `undefined` — by default; see §9). Mutated by `enableNfpIfpTelemetry`
   (full reset, `:132-134`), `disableNfpIfpTelemetry` (`:137-139`), and the
   seven `record*` functions, each a guarded increment.

No other mutable state exists in this cluster. `computeTransformedCollisionGeometry`,
`makePairwiseNfpCacheKey`, `makeTransformCollisionGeometryCacheKey`,
`makeInnerFitBoundsCacheKey`, `boundsForPoints`, `sameTransform`,
`isValidCached*` are all pure functions over their arguments.

## 5. Ordering sources

- **`Map` insertion order** in the backing store
  (`geometryCacheStoreLive.ts:10`) is never iterated — the store is
  point-lookup only (`get`/`set`/`remove`/`clear`), so `Map` iteration order
  is not an observable ordering source in this cluster.
- **`WeakMap`** (`nfpBoundaryCore.ts:31`) has no iteration order at all (not
  enumerable) and is used purely as an identity-keyed side table.
- **Array construction order in `cyclicPolygonDigest`**
  (`core/nfpCacheKey.ts:76-89`) is deterministic and index-driven (`for` loop
  over `points.length`), not derived from any prior sort — order is fixed by
  caller-supplied polygon vertex order plus the chosen `startIndex`/`direction`.
- **`geometrySettingsParts`, `transformDigest`, `pointDigest`, key `parts`
  arrays**: all constructed as literal-order arrays (`nfpCacheKey.ts:49-57,91-98,100-102`;
  `geometryCacheIdentity.ts:41-46,54-59,98-106,130-137`), i.e. array-literal
  order *is* the specification — there is no separate "sort" step; the array
  literal's source order is the canonical order and must be reproduced
  verbatim, element-for-element, by any Rust reimplementation.
- **`NfpIfpTelemetry` snapshot ordering** (`nfpIfpTelemetry.ts:142-169`): both
  `namespaces` and `checkpoints.byPhase` are rebuilt from their backing `Map`s
  via `[...map].toSorted(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)`
  (`:146-148,152-154`) — i.e. **lexicographic ASCII/UTF-16 code-unit string
  sort of the namespace/phase name**, not `Map` insertion order, before
  building the returned plain object. This is the one true "sort" in this
  cluster, and it is diagnostic-only (telemetry sidecar), never on the
  semantic/canonical output or key path — see §12 for exact string-ordering
  hazard notes.
- No `.sort()`/`.toSorted()` call in `nfpCacheKey.ts`, `geometryCacheIdentity.ts`,
  `geometryCacheStore.ts`, `geometryCacheKeys.ts`, `geometryCacheStoreLive.ts`,
  `transformCollisionGeometryCore.ts`, or `transformCollisionGeometry.ts`
  touches cache keys or values. (`geometryCacheKeys.ts` does sort in an
  unrelated context — none; the sorts affecting candidate generation live in
  `nfpIfpService.ts`, out of this cluster's scope.)

## 6. Comparators and tie rules

This cluster has almost no numeric comparators of its own; its "comparators"
are string-equality-based cache-key comparisons and one canonical-orientation
tie rule inside `canonicalPolygonDigest`:

- **`canonicalPolygonDigest`** (`nfpCacheKey.ts:59-74`): finds the
  lexicographically-smallest-`(x,y)` start vertex by scanning
  `candidate.x < current.x || (candidate.x === current.x && candidate.y < current.y)`
  (`:66`) — **strict `<`, first-occurrence wins on ties** (later equal
  candidates do not replace `startIndex` because the condition is strict, not
  `<=`). Then it builds both the forward (`direction = 1`) and reverse
  (`direction = -1`) cyclic digest strings from that start index
  (`cyclicPolygonDigest`, `:76-89`) and returns
  `forward < reverse ? forward : reverse` (`:73`) — **plain JS string `<`,
  i.e. UTF-16 code-unit comparison** of the two candidate digest strings. This
  makes the polygon key **winding-invariant and rotation-invariant**: the same
  ring, reversed or rotated to any start vertex, produces the identical cache
  key string, by design (comment context in `nfpBoundaryCore.ts`/tests
  confirms `canonicalizeTranslatedConvexRingCore`/NFP-sharing tests expect
  this — see the "shares one relative NFP boundary across copies" test,
  `irregularGeometryCache.test.ts:399-443`).
- **`isValidCachedNfpBoundary`** (`core/nfpBoundaryCore.ts:249-253`) is a
  boolean predicate, not a comparator: `points.length >= 3` AND
  `validateStrictBoundaryOnce(value.points)` returns no `message`. No numeric
  tolerance; exact strict-convexity re-validation.
- **`isValidCachedTransformedCollisionGeometry`**
  (`transformCollisionGeometryCore.ts:115-137`): exact field equality chain —
  `value.sourcePieceId !== input.geometry.sourcePieceId` → reject;
  `!sameTransform(...)` → reject; `polygon.points.length < 3` → reject;
  re-`validateStrictBoundary` → reject on failure; then **exact `===`**
  equality of all four recomputed bounds fields against the cached `.bounds`
  (`:131-136`) — no tolerance, no rounding.
- **`sameTransform`** (`geometryCacheIdentity.ts:86-96`): `&&`-chain of four
  exact `===` comparisons (`index`, `rotationDeg`, `mirrored`, `reason`); no
  numeric tolerance on `rotationDeg` (e.g. `0` and `360` are **not** treated
  as the same transform by this predicate, even though
  `normalizeRotationDegrees` in `transformCollisionGeometryCore.ts:146-149`
  would treat them identically for the actual geometric transform — the cache
  key and `sameTransform` check operate on the raw, unnormalized
  `rotationDeg` field of the transform candidate object).
- **`isValidCachedIfpBounds`** (`core/ifpBoundsCore.ts:100-123`): exact
  field-by-field `===` equality of `movingPieceId`, `sheet.width`,
  `sheet.height`, and all four recomputed bounds values against the cached
  value, plus an `Number.isFinite` check over the four bounds numbers — no
  tolerance.
- **`numberKey`** (`nfpCacheKey.ts:104-106`, `geometryCacheIdentity.ts:139-141`,
  duplicated verbatim in `geometryCacheKeys.ts:158-160`): `Object.is(value, -0) ? '0' : String(value)`.
  This is a **tie rule for signed zero**: `-0` and `0` produce the identical
  key substring `'0'`, but every other number renders through JS's default
  `Number.prototype.toString()` algorithm (shortest round-trippable decimal,
  exponential notation above/below certain magnitudes — e.g. `1e-7`,
  `1e21`). This exact stringification algorithm (`ECMA-262 Number::toString`)
  has no built-in Rust equivalent and must be reproduced bit-for-bit for key
  parity (§7, §12, §15 — flagged as a top port risk).

## 7. Numeric semantics

- **No `BigInt`** anywhere in this cluster.
- **Signed zero normalization** occurs in three independent places with two
  different techniques, and they are *not* interchangeable:
  - `numberKey` (§6 above): folds `-0` into the string `'0'` only for the
    purpose of the cache-key text; does not change the underlying value.
  - `normalizeNegativeZero` (`transformCollisionGeometryCore.ts:180-182`):
    `Object.is(value, -0) ? 0 : value` — folds `-0` into `+0` in the **actual
    returned coordinate value**, applied to every transformed point
    (`transformPoint`, `:151-178`, every `return` branch) and to every
    snapped point (`snapPointToCollisionGrid`, `:139-144`). This is why the
    cache *values* for `transform-collision-v1` never contain `-0`
    coordinates even though intermediate arithmetic (e.g. `-point.x` for
    mirroring, or `-y`/`-x` for 90°/180°/270° rotation) can produce `-0`.
  - `ifpBoundsCore.ts:129-131` (`normalizeNegativeZero`, a separate local
    copy of the identical function) — applied to all four IFP bound values
    (`:74-77`) before the finiteness check.
  - **Port risk**: three textually-independent copies of the same two-line
    function exist across this cluster (`transformCollisionGeometryCore.ts`,
    `ifpBoundsCore.ts`, plus the string-only `numberKey` variant in three
    files). A Rust port collapsing these into one shared helper is safe
    *only if* it is applied at exactly the same call sites with exactly the
    same "is this an intermediate value or a stored/keyed value" boundary —
    see §15.
- **Rejection of NaN/Infinity**: `boundsForPoints`
  (`geometryCacheIdentity.ts:64-84`) returns `undefined` (not a bounds value)
  the moment any coordinate fails `Number.isFinite` (`:67,75`) — short-circuit
  on the **first** point only for the *first* point (`:67`), but a full scan
  with early-return for every subsequent point (`:73-77`). `toGridMm`
  (`clipper2OffsetPolicy.ts:44-53`) returns `undefined` for non-finite input
  (`:45`) or for a scaled value that overflows to non-finite (`:48`) or for a
  result outside `Number.isSafeInteger` (`:52`).
- **Safe-integer checks**: `toGridMm`'s final guard is
  `Number.isSafeInteger(gridValue)` (`clipper2OffsetPolicy.ts:52`), i.e. the
  grid coordinate (millimeters × 1000, §7 grid conversion below) must fit
  within `±2^53 - 1`. `canonicalPlacementPointAlternatives` in
  `nfpIfpService.ts:580` (out of this cluster's primary scope but downstream
  of `toGridMm`) also gates on `Number.isSafeInteger` for both grid axes.
- **Rounding/truncation — canonical grid conversion** (`clipper2OffsetPolicy.ts:44-58`,
  the authoritative grid policy consumed by `snapPointToCollisionGrid`,
  `transformCollisionGeometryCore.ts:139-144`):
  - `scale = 1000` (mm → grid units, i.e. micrometers), `gridStepMm = 0.001`.
  - `toGridMm(valueMm)`: `scaledAbsoluteValue = |valueMm| * 1000`;
    `roundedAbsoluteValue = Math.floor(scaledAbsoluteValue + 0.5)` (**round
    half away from zero on the absolute value**, matching the documented
    policy `rounding: 'nearest grid point, ties away from zero'` in
    `CLIPPER2_OFFSET_POLICY.rounding`, `clipper2OffsetPolicy.ts:13`);
    `gridValue = Math.sign(valueMm) * roundedAbsoluteValue`. `Math.sign(0)`
    is `0`, so a `valueMm` of exactly `0` (or `-0`) yields `gridValue = 0`.
    `Math.sign(-0)` is also `-0` in JS, but `-0 * roundedAbsoluteValue` stays
    `-0` only if `roundedAbsoluteValue !== 0`; when the input is exactly `-0`,
    `scaledAbsoluteValue` is `0`, `roundedAbsoluteValue` is `Math.floor(0.5) = 0`,
    and `Math.sign(-0) * 0 === -0` in JS arithmetic (`-0 * 0 = -0` per
    IEEE-754) — but `Number.isSafeInteger(-0)` is `true` in JS, so `toGridMm(-0)`
    returns `-0`, not `0`. **This is a subtle signed-zero edge case a Rust
    port must reproduce exactly if any caller passes literal `-0.0` mm
    coordinates through this path** — Rust's `f64` also has `-0.0` and
    `Number.isSafeInteger` semantics can be reproduced with an integer check
    after the float round-trip, but the *result* must still carry `-0.0`
    forward if JS does, or every downstream `normalizeNegativeZero` call
    changes behavior. In this cluster specifically,
    `snapPointToCollisionGrid` immediately re-normalizes with
    `normalizeNegativeZero(fromGrid(x))` (`transformCollisionGeometryCore.ts:143`),
    so the eventual *stored* value never has `-0`, but the fact that
    `toGridMm` can legitimately produce `-0` as an intermediate integer is a
    detail a Rust port must not silently "fix" (e.g. by using `.round()`
    which in Rust rounds half away from zero on the signed value directly and
    could diverge for edge cases near representable-boundary values — verify
    bit-for-bit before relying on `f64::round`).
  - `fromGrid(value)`: plain `value / 1000`, no additional rounding pass
    (`clipper2OffsetPolicy.ts:56-58`) — this is a straight IEEE-754 division,
    order-sensitive only in the sense that it must be literally
    `value / 1000.0` in Rust, not `value * 0.001` (these are not bit-identical
    in general IEEE-754 arithmetic).
- **Rotation transform arithmetic** (`transformPoint`,
  `transformCollisionGeometryCore.ts:151-178`): the four axis-aligned
  rotations (`0/90/180/270`) use **exact sign-flip/swap, not
  trigonometric functions** (`:159-167`) — this guarantees exact results with
  no floating error for the common case. Only the `default` branch
  (arbitrary-angle transforms) uses `Math.cos`/`Math.sin` on
  `(rotationDeg * Math.PI) / 180` (`:169-176`). `normalizeRotationDegrees`
  (`:146-149`) reduces the input to `[0, 360)` via `%` with a negative-result
  correction (`remainder < 0 ? remainder + 360 : remainder`) *before* the
  switch — so a `rotationDeg` of exactly `360` normalizes to `0` and takes the
  exact branch, while `rotationDeg = -90` normalizes to `270` and also takes
  an exact branch. **A Rust port must replicate the exact-branch special
  cases for `{0,90,180,270}` verbatim** — using `f64::sin`/`f64::cos`
  uniformly for all four would very likely diverge in the last bit(s) from
  the JS exact-arithmetic branches, breaking the canonical-grid snap
  (`Number.isSafeInteger`) or producing a coordinate that snaps to a
  different grid cell than TypeScript.
- **Multiplication/addition order**: `transformPoint`'s arbitrary-angle branch
  computes `x * cos - y * sin` and `x * sin + y * cos` (`:173-174`) in that
  exact left-to-right operand order; Rust must preserve this exact expression
  form (not e.g. `-(y * sin) + x * cos`) to guarantee bit-identical IEEE-754
  results.
- **Number-to-string rendering for keys**: see §6 `numberKey` — this is the
  single largest "JS-specific" numeric-semantics hazard in this cluster
  because it depends on `ECMA-262`'s `Number::toString` shortest-round-trip
  algorithm, which differs from Rust's default `f64` `Display`/`{:?}`
  formatting (Rust's default float formatting is also "shortest
  round-trippable" via the Grisu/Ryu-family algorithm since 1.x, but is not
  guaranteed byte-identical to V8's implementation for all magnitudes/edge
  cases — e.g. exponential-notation thresholds, trailing-zero suppression
  rules). See §15.
- No `Math.round`/`Math.trunc`/`Math.ceil` calls anywhere in this cluster
  outside `Math.floor` in `toGridMm` and `Math.min`/`Math.max` in
  `boundsForPoints`/`ifpBoundsCore`-adjacent bounds helpers.

## 8. Serialization and hashing

- **`serializeGeometryCacheKey`** (`core/geometryCacheStore.ts:13-15`):
  `JSON.stringify([key.namespace, key.parts])`. This is the **entire**
  serialization contract for this cluster's cache keys — a 2-element JSON
  array `[namespace_string, [part_string, ...]]`. `JSON.stringify` on an
  array of strings quotes and escapes each string per JSON string-escaping
  rules (backslash, double-quote, control characters, and — critically —
  **lone/unpaired UTF-16 surrogates are passed through unescaped by
  `JSON.stringify`**, producing technically-invalid-but-V8-consistent JSON
  text; this only matters if any `reason`/`label`/`geometryBackendId` string
  ever contains such code units, which is unlikely in practice but is a
  faithful-reproduction hazard for a Rust `serde_json`-based port, since
  `serde_json` errors or replaces lone surrogates differently by default).
  No `BigInt`, no `undefined` field omission (arrays of strings only; there
  are no object keys to omit or reorder — see §9's confirmed literal example
  below).
- **Concrete confirmed key bytes** (from
  `tests/unit/nfpBoundaryCore.test.ts:38-53` and
  `tests/unit/pureIfpTransformContract.test.ts:184-189`):
  ```
  ["pairwise-nfp-relative-v3",["fixed-polygon=0,0;0,4;4,4;4,0","moving-polygon=0,0;0,2;2,2;2,0","fixed-transform=index=0,rotation=0,mirrored=0,reason=configured","moving-transform=index=0,rotation=0,mirrored=0,reason=configured","flattening-sag=0.05","clearance-margin=0.05","backend=clipper2-ts","backend-version=2.0.1-18","offset-policy=clipper2-offset-v3-sharp-miter-scale-1000","nfp-algorithm=convex-fixed-plus-negated-moving-relative-v3","nfp-construction=vertex-pair-hull"]]

  ["transform-collision-v1",["source=key-piece;source-bounds=0,0,4,3;placement-reference=0,0;hull=0,0;4,0;4,3;0,3;collision=0,0;4,0;4,3;0,3","index=7,rotation=90,mirrored=1,reason=configured","flattening-sag=0.25","clearance-margin=0.25","backend=irregular-convex-v2-default","backend-version=0","offset-policy=clipper2-offset-v3-sharp-miter-scale-1000","placement-reference=local-lower-left","transform-operation=mirror-y-then-ccw-rotate"]]

  ["sheet-ifp-v1",["sheet=20,15,key sheet","moving-piece=key-piece","moving-transform=index=7,rotation=90,mirrored=1,reason=configured","moving-polygon=0,0;4,0;4,3;0,3","ifp-operation=rectangular-sheet-vertex-bounds"]]
  ```
  These are **golden byte strings pinned by tests**; any Rust key-serialization
  reimplementation must reproduce these exactly for these exact inputs (and
  by extension, for all inputs, since the tests only sample a few concrete
  cases).
- **Separator bytes inside `parts` elements** (not JSON separators — these are
  internal to each string before JSON-escaping applies): `,` (coordinate
  x/y separator, and index/rotation/mirrored/reason field separator inside
  `transformDigest`), `;` (point-list separator inside a polygon digest),
  `=` (key/value separator, e.g. `fixed-polygon=...`), `:` and `.` (via plain
  `String(number)`, e.g. decimals and future timestamp-like values — none
  present today), `@` — **not used in this cluster** (that separator belongs
  to `geometryCacheKeys.ts`'s `legalPlacementCandidateMemoKey`, a different
  cache namespace, `geometryCacheKeys.ts:92`). Because `numberKey` never
  produces a string containing `,` or `;` (the comment at
  `nfpBoundaryCore.ts:59` explicitly notes "Number strings cannot contain `,`
  or `;`" for a related fingerprint, and the same holds for `String(number)`
  output in JS: digits, `-`, `.`, `e`, `+` only), there is no ambiguity risk
  in splitting these parts back apart, though nothing in production code ever
  needs to.
- **No SHA-256 anywhere in this cluster.** Cache keys are plain JSON strings
  used directly as `Map` keys; there is no hashing/digesting step. (SHA-256
  identities — collision/fitted canonical hashes — are a *different*
  subsystem entirely, computed elsewhere in the codebase, not part of this
  cluster.)
- **`JSON.stringify` is also not used for cache *values***, only for *keys*.
  Values are stored as live JS objects/class-instances by reference
  (`Map<string, unknown>`), so no serialization round-trip occurs for values
  within one job; this matters for §9 (identity is preserved for hits, see
  the "keeps live sync and Effect views coherent" and
  "returns the same boundary on repeated resolutions" test assertions using
  `toBe`, not just `toEqual`).

## 9. Caches touched and the exact historical access sequence

Three distinct resolvers in this cluster, each with its own pinned
access-order contract (all three share the identical high-level shape:
**validate → key → get → [decide: hit / stale-evict+recompute / miss+compute]
→ [set] → return**), confirmed by dedicated tests that literally assert the
ordered action log.

### 9.1 Pairwise NFP (`core/nfpBoundaryCore.ts::resolveNfpBoundary`, `:125-167`)

Exact ordered steps:
1. `validateStrictBoundaryOnce(fixed.collisionGeometry.polygon.points)`
   (`:130-133`) — **before any cache key is built.** On failure, return
   immediately; **zero cache actions occur** (confirmed:
   `nfpBoundaryCore.test.ts:74-94`, `cache.actions` is `[]`).
2. `validateStrictBoundaryOnce(moving.polygon.points)` (`:135-136`) — same
   short-circuit-before-cache rule.
3. `makePairwiseNfpCacheKey(...)` (`:138-147`).
4. `cache.get<InternalPolygon>(key)` (`:148`) — **exactly one `get` call**,
   regardless of hit/miss/stale outcome.
5. `isValidCachedNfpBoundary(cached)` (`:151`):
   - **Hit** (valid): use `cached` directly, **no recomputation, no
     `set`**, proceed to translation. Action log: `['get:hit']`.
   - **Stale** (`cached !== undefined` but invalid): `cache.remove(key)`
     (`:154`), **then** compute fresh (`computeRelativeNfpBoundary`,
     `:155-159`), then `cache.set(key, computed)` (`:162`). Action log:
     `['get:hit', 'remove', 'set']` (order fixed: remove strictly precedes
     set; confirmed `nfpBoundaryCore.test.ts:56-67`).
   - **Miss** (`cached === undefined`): skip `remove`, compute fresh, `set`.
     Action log: `['get:miss', 'set']` (confirmed `:28-54`).
   - **Compute failure** (miss path only — a stale-evicted slot's
     recomputation can also fail): if `computeRelativeNfpBoundary` returns a
     `message`, return the failure **without ever calling `cache.set`**
     (`:160`); confirmed no-store-on-overflow (`nfpBoundaryCore.test.ts:96-113`,
     action log `['get:miss']` only).
6. `translateNfpBoundary(input, relativeBoundary)` (`:165`) — **always runs
   after the cache decision, on every call (hit or miss)**, never itself
   touches the cache. If translation overflows (fixed placement translation
   produces a non-finite coordinate), the **already-published relative
   boundary from step 5 is retained in the cache** even though this specific
   call fails (confirmed `nfpBoundaryCore.test.ts:115-136`: action log
   `['get:miss', 'set']`, `cache.values.size === 1` even though the overall
   `resolveNfpBoundary` call returns `{ ok: false }`). **This is a load-bearing
   asymmetry**: a translation failure is a per-call, per-fixed-placement
   failure, not a geometry-invalidity failure, so the shared relative boundary
   remains valid and cached for other fixed placements of the same
   canonical-equivalent geometry.
7. **Trusted-ring fingerprint shortcut inside `validateStrictBoundaryOnce`**
   (`:39-55`, the "SPECIAL FOCUS" mechanism): keyed by **array identity**
   (`WeakMap<object, ...>`, i.e. `points` itself as the map key, not its
   content) — see §9.4 below for the exact fingerprint rule.

### 9.2 Rectangular IFP (`core/ifpBoundsCore.ts::resolveIfpBounds`, `:37-59`)

1. `ConvexPolygonValidation.validateStrictBoundary(input.moving.polygon.points)`
   (`:45`) — before the key/cache; on failure return `invalid(...)` with
   **zero cache actions** (confirmed `ifpTransformCore.test.ts:213-233`,
   `pureIfpTransformContract.test.ts:290-313`).
2. `makeInnerFitBoundsCacheKey(input)` (`:48`).
3. `cache.get<...>(key)` (`:49`) — exactly one `get`.
4. `isValidCachedIfpBounds(cached, input)` (`:50`):
   - **Hit**: return cached value directly, no recompute/set.
   - **Stale**: `cache.remove(key)` (`:54`) then compute then `cache.set`
     (`:57`) — same remove-then-set ordering as NFP (confirmed
     `pureIfpTransformContract.test.ts:336-356`, action log
     `['get', 'remove', 'set']`).
   - **Miss**: compute then `set` (confirmed `ifpTransformCore.test.ts:187-211`,
     action log `['get', 'set']`, plus a **third `get`** issued by the test
     itself to observe the cached value — not part of the resolver's own
     sequence).
5. **Two distinct failure kinds after the `get`**, both **without a `set`**:
   `kind: 'invalid'` (arithmetic overflow, `ifpBoundsCore.ts:78-85`,
   confirmed `ifpTransformCore.test.ts:256-277`, action log `['get']` only)
   and `kind: 'infeasible'` (piece cannot fit the sheet even with finite
   arithmetic, `:86-89`, confirmed `ifpTransformCore.test.ts:235-253`, action
   log `['get']` only). Both are distinguished from the pre-cache `'invalid'`
   validation failure of step 1 (which has **zero** cache actions, not one).
   This three-way split (`0 gets` / `1 get, no store` / `1 get + set`) is a
   precise contract a Rust port's error-kind enum must preserve exactly,
   because callers (`nfpIfpService.ts:293-306`) branch differently on
   `'invalid'` (hard failure) vs `'infeasible'` (soft "no candidates from
   this piece", not a hard error).

### 9.3 Transformed collision geometry (`core/transformCollisionGeometryCore.ts::resolveTransformedCollisionGeometry`, `:38-63`)

1. `makeTransformCollisionGeometryCacheKey(input, settings)` (`:51`) — **no
   pre-key validation step here** (unlike NFP/IFP); the key is built from raw
   input fields without first calling `ConvexPolygonValidation` — validation
   happens only as part of `computeTransformedCollisionGeometry` on a miss, or
   as part of `isValidCachedTransformedCollisionGeometry` on a candidate hit.
   So the **first cache action is always the `get`**, confirmed by
   `ifpTransformCore.test.ts:136-161` (invalid-input case still shows
   `[{operation:'get', ...}]` as its only action — the failure originates
   *after* the `get`, inside `computeTransformedCollisionGeometry`, not
   before it).
2. `cache.get<TValue>(key)` (`:52`).
3. `isValidCachedTransformedCollisionGeometry(cached, input)` (`:53`):
   - **Hit**: return `{ ok: true, value: cached, key }` — **no `set`**, and
     critically **no call to `materialize()`** (the domain-adapter callback)
     on a hit; `materialize` runs only on the miss/stale path (`:60`). This
     is why the "reuses transformed collision geometry" test observes
     `transformed[0] === transformed[1]`-by-`toEqual` but with only **one**
     `set` for **two** `get`s (`irregularGeometryCache.test.ts:321-348`,
     counters `{gets: 2, sets: 1}`), and why the "resolves and reuses" pure
     test asserts the **exact same object reference** flows through on a
     hit: `expect(transformHit).toBe(transformAfterStale)`
     (`irregularGeometryCache.test.ts:267`) even across a stale-then-fresh
     boundary within one `Effect.gen` block, because the store itself (a
     plain `Map`) returns the identical stored reference.
   - **Stale**: `cache.remove(key)` (`:57`), compute
     (`computeTransformedCollisionGeometry`, `:58`), `materialize(computed.value)`
     (`:60`), `cache.set(key, value)` (`:61`) — remove strictly before
     compute/set (confirmed `pureIfpTransformContract.test.ts:192-217`, action
     log `[get, set, get, get, remove, set]` across three calls: first call
     miss → `[get, set]`; second call hit → `[get]`; third call after
     external staleing → `[get, remove, set]`).
   - **Miss**: compute, materialize, set — no remove (confirmed
     `ifpTransformCore.test.ts:104-134`, action log
     `[get, set, get]` across two calls: first `[get, set]`, second (hit)
     `[get]`).
4. **Compute failure** (`computeTransformedCollisionGeometry` returns
   `{ok: false}`, either from strict-boundary validation of the *source*
   collision polygon, from non-finite transformed coordinates, from a
   canonical-grid-overflow snap failure, or from strict-boundary validation
   of the *transformed* polygon) — the failure is returned **without ever
   calling `cache.set`**, and this happens **after** the single required
   `get` (confirmed for three distinct failure causes:
   `ifpTransformCore.test.ts:136-161` non-convex source,
   `ifpTransformCore.test.ts:163-185` grid overflow,
   `pureIfpTransformContract.test.ts:219-266` both cases through the Effect
   wrapper). This "lookup happens even though it will be a miss that then
   fails" ordering is explicitly named in the file's own doc comment:
   *"Resolves transformed collision geometry while preserving
   key/get-before-validation ordering"* (`transformCollisionGeometryCore.ts:37`).

### 9.4 The ordered-coordinate fingerprint rule for trusted-ring reuse (SPECIAL FOCUS)

Location: `core/nfpBoundaryCore.ts:19-88` (module doc comment + implementation).

**Purpose**: `ConvexPolygonValidation.validateStrictBoundary` is O(n²) in the
general (non-linear-topology) case, and one warm pairwise NFP resolution used
to call it **four times** per call: once for the fixed input ring, once for
the moving input ring, once for the cached relative boundary read back from
the store, and once for the translated ring
(`canonicalizeTranslatedConvexRing`'s validation). The fingerprint mechanism
(`validateStrictBoundaryOnce`) is shared by **three** of those four sites —
the fixed-input validation (`resolveNfpBoundary:130-133`), the moving-input
validation (`:135-136`), and the cached-relative-boundary check
(`isValidCachedNfpBoundary`, `:249-253`, which calls
`validateStrictBoundaryOnce(value.points)` at `:252`) — each keyed
independently by its own array's identity. Only the **fourth** site, the
*translated* ring's validation inside `canonicalizeTranslatedConvexRing`
(`ConvexPolygonValidation.validateStrictBoundary` called directly at `:244`,
and again in the hull-fallback path at `:488`), bypasses the memo and always
pays the full quadratic cost — because a freshly-translated points array is a
brand-new object on every call (built by `translateNfpBoundary`, `:469-477`)
and can never be identity-stable across calls, so memoizing it would never
produce a hit. This matches the source documentation directly: "the hardened
memo keeps the translated ring check and replaces the other repeated
quadratic checks with linear fingerprint comparisons"
(`docs/research/trusted-ring-validation-memo.md:22-27`).

**Exact mechanism** (`validateStrictBoundaryOnce`, `:39-55`):
1. Compute `fingerprint = ringFingerprint(points)` (`:42`).
2. Look up `memoized = validatedRings.get(points)` — **keyed by the array
   object's identity** (`WeakMap`, so garbage-collectable once the array is
   unreachable — this is why the doc comment says "Entries are weakly held
   and disappear with the geometry that produced them", `:29`).
3. If `fingerprint !== undefined && memoized?.fingerprint === fingerprint`,
   **return the memoized validation result without re-validating** (`:44-46`).
4. Otherwise, call the real `ConvexPolygonValidation.validateStrictBoundary(points)`
   (`:48`), then:
   - if `fingerprint === undefined` (ring currently contains non-finite or
     structurally-broken content), `validatedRings.delete(points)` (`:50`) —
     **do not memoize an un-fingerprintable state**, so the *next* call is
     forced to re-validate from scratch even if the array identity is
     unchanged, rather than caching a `false`/error result under a
     placeholder key.
   - otherwise `validatedRings.set(points, { fingerprint, validation })`
     (`:52`) — publish the *fresh* fingerprint alongside the *fresh*
     validation result (which itself may be a failure — invalid rings **are**
     memoized as invalid, and stay invalid until the fingerprint changes;
     confirmed `nfpBoundaryTrustedRings.test.ts:92-108`, "keeps rejecting an
     invalid input ring on every resolution" — meaning the failure result is
     served *identically* on repeat calls, which the test observes as
     `toEqual(first)`, not as "always recomputes and always fails the same
     way" — the memo genuinely returns the cached failure object).

**`ringFingerprint`** (`:68-84`) exact construction: string starts with
`"${points.length}:"`, then for each index `0..points.length` (**read by
numeric index, not `for..of`/iterator** — this is deliberate and load-bearing,
see below), if the element is `undefined`, not an `object`, `null`, or has a
non-finite `x`/`y`, the **whole fingerprint computation aborts and returns
`undefined`** (not a partial string) — a single bad point poisons the entire
fingerprint, forcing full revalidation (and forcing the `validatedRings.delete`
branch above). Otherwise appends
`` `${numberIdentity(point.x)},${numberIdentity(point.y)};` `` per point
(`:81`), where `numberIdentity` (`:86-88`) is the same `Object.is(value,-0) ?
'0' : String(value)` pattern as `numberKey` elsewhere in this cluster (signed
zero folded to `'0'` for fingerprint-identity purposes, meaning a ring whose
coordinate flips only between `0` and `-0` is treated as unchanged — matching
that `validateStrictBoundary` itself treats `0`/`-0` identically per the
module doc comment on `convexPolygonValidation.ts`... actually the exact
justification is stated directly: *"Signed zero is normalized because strict
validation treats it identically to zero"*, `nfpBoundaryCore.ts:60-61`).
`,` and `;` are chosen as separators specifically because `Number.prototype.toString()`
output can never contain them (`:59`, explicit comment), so no ambiguity/
collision is possible between fingerprints of rings with different vertex
counts or coordinate splits.

**Why index-based reads, not iterator-based reads** — this is the entire
point of the dedicated `ringFingerprintAccessPath.test.ts` suite: the guard
must observe the ring **exactly the way `validateStrictBoundary` itself reads
it** (which is also by numeric index throughout `convexPolygonValidation.ts`),
so that a hostile/unusual array whose `Symbol.iterator` and index-access views
disagree cannot make the fingerprint see stable content while validation sees
mutated content (or vice versa). The test builds a ring whose
`Symbol.iterator` always replays a frozen snapshot while its indexed elements
are mutated in place, and confirms:
- A rejected (collinear) ring, once its **indexed** positions are mutated to
  become valid, gets **re-validated and accepted** — because the fingerprint,
  reading by index, sees the change even though a hypothetical
  iterator-reading guard would not
  (`ringFingerprintAccessPath.test.ts:94-125`).
- A "plain ring" behaves identically whether the input's iterator is frozen
  or not (`:127-155`), because production code never actually calls
  `[...points]`/`for..of` on these arrays before this validation boundary —
  the equivalence is a sanity check, not evidence the mechanism depends on
  iterator behavior in production.
- The known **residual gap**, stated explicitly in the test file's own doc
  comment (`ringFingerprintAccessPath.test.ts:1-16`): this closes the
  guard/validation *read-path* divergence but does **not** make the two reads
  atomic — coordinates exposed through accessors (e.g. getters) could still
  change *between* the fingerprint's read and validation's read within one
  call, and this residue is accepted deliberately because "no caller in this
  worker supplies anything but plain arrays of plain points." **A Rust port
  has no equivalent hazard** (Rust has no getter-based array-element
  mutation-during-iteration hazard of this kind for `&[Point]`/`Vec<Point>`
  slices), so this specific test's *rationale* does not need porting, but its
  *specification* (index-based, not iterator-based, and the exact
  fingerprint format) still fully constrains what "the same ring content"
  means for reuse purposes and must be preserved as a memoization-correctness
  invariant even if implemented completely differently in Rust (e.g. via
  `Arc<[Point]>` pointer-identity plus a content hash, or simply always
  revalidating since Rust has no realistic risk of the JS mutable-array
  hazard this memo defends against — see §15 open question on whether the
  memo itself is even necessary in Rust).

**Relative-NFP-sharing across canonically-equivalent copies** (the other half
of this section's SPECIAL FOCUS): confirmed end-to-end by
`irregularGeometryCache.test.ts:399-443` — two structurally distinct
`ComputeNfpInput`s (different piece IDs, different vertex *array* objects, but
geometrically identical rings under the winding/rotation-invariant
`canonicalPolygonDigest`, §6) produce `firstKey` **`toEqual`** `secondKey`
(deep-equal, not identity — these are freshly-constructed key objects), a
single `set` (`counters === {gets: 2, sets: 1, removes: 0}`), and the
retrieved cached value has **neither** `fixedPieceId` nor `movingPieceId`
fields (`:441-442`) — reconfirming that the cached value is the piece-agnostic
*relative* boundary, and piece identity is reattached by the caller
(`nfpIfpService.ts:120-125`) after cache retrieval, never stored.

### 9.5 Cache lifetime: job-local, not process-global

`makeGeometryCacheStore()` (`geometryCacheStoreLive.ts:9-30`) constructs a
brand-new `Map` every call. It is called exactly once per
`GeometryCacheLive`/`GeometryCacheInMemory` layer construction
(`services.ts:436-448`), which happens once per worker request
(`nesting.worker.ts:377-397`, §1). There is **no cross-job cache reuse, no
process-global singleton store, and no explicit eviction policy** beyond the
per-key stale-replace-on-read behavior described above — the entire cache
(all three namespaces) is discarded when the job's Effect scope ends (garbage
collected once the layer's runtime is dropped; `clear()` is available and
used by tests but is not called by production code as part of normal
completion — confirm this is genuinely GC-only cleanup in production, not an
explicit `clear()` call somewhere in `computeIrregularNesting.ts`; grep found
no production call to `GeometryCache.clear`/`cache.clear`/`store.clear`
outside test files).

**Exception**: `validatedRings` (§4, `nfpBoundaryCore.ts:31`) is a
**module-level** `WeakMap`, not constructed per-job. It survives across
worker requests within the same process (a long-lived worker thread handling
multiple nesting jobs sequentially would share this one `WeakMap` instance
across jobs). Because it is a `WeakMap` keyed by array object identity, and
because each job constructs fresh geometry arrays, this does not leak stale
*data* across jobs in practice (no job can observe another job's entries
because no job holds a reference to another job's point arrays), but it is
still a **process-lifetime, not job-lifetime, cache**, and a Rust port must
decide explicitly whether to reproduce this as thread-local, job-scoped, or
(if truly a pure performance optimization masking no semantic dependency)
omit it entirely — see §13 and §15.

### 9.6 Statistics counters (`nfpIfpTelemetry.ts`, full behavioral contract)

Opt-in, off by default (`state: MutableState | undefined = undefined`,
`:95`), explicitly documented as having **zero overhead when disabled**
("every recorder is a single `undefined` comparison... and allocates
nothing", `:9-11`) and as intentionally excluding timing ("Timing is excluded
because an inner-loop timer would add substantially more disturbance", `:6-7`).
Per-namespace counters tracked by this cluster's store
(`geometryCacheStoreLive.ts:11,15,20,24` call sites):
- `getCalls` (every `get`, hit or miss), `getPresent` (**gets that returned a
  defined value — this includes stale hits that are about to be evicted**,
  per the doc comment "Lookups that returned a defined value, valid or
  stale", `:21-22` — i.e. `getPresent` is **not** the same as "valid cache
  hit rate"; a namespace with many stale entries would show a high
  `getPresent` fraction while still doing full recomputation on most of those
  "present" lookups). `setCalls` (every store), `removeCalls` (every evict;
  per the doc comment this equals the stale count exactly, `:25-26`, since
  removal only ever happens on the stale-eviction branch in this cluster's
  resolvers).
- `cacheInstances`: incremented once per `makeGeometryCacheStore()` call
  (`:172-175`), i.e. once per job when telemetry is enabled — this is how a
  differential/perf harness can assert "one cache per job" as an explicit,
  testable invariant (confirmed `irregularGeometryCache.test.ts:199,276`,
  `expect(nfpIfpTelemetrySnapshot()?.cacheInstances).toBe(1)`).
- Snapshot determinism: `nfpIfpTelemetrySnapshot()` (`:142-169`) returns a
  **detached copy** (spread `{...counters}`, new plain objects for
  `namespaces`/`checkpoints.byPhase`) sorted by namespace/phase name (§5) —
  confirmed by the "returns detached, deterministically ordered snapshots"
  test that mutates state after taking a snapshot and shows the earlier
  snapshot is unaffected (`nfpIfpTelemetry.test.ts:66-119`).
- This telemetry is **never read by any control-flow decision** in this
  cluster or its callers within scope — it is purely observational, matching
  migration-prompt §13.7's non-semantic-diagnostic-channel requirement
  already in force in the current implementation. The `--capture-cache-telemetry`
  flag on `scripts/irregular-sheet-invariance.ts:128-129,643` is the only
  production-adjacent enabler, writing a `cache-telemetry.json` sidecar
  (`:628-634`) that is explicitly *not* part of the pass/fail gate contract
  (the gate's `passed` boolean, `:625-627`, does not read telemetry).

## 10. Cancellation / deadline / budget / evaluation-cap observation points

**None exist inside this cluster's seven files.** None of
`nfpCacheKey.ts`, `geometryCacheIdentity.ts`, `geometryCacheStore.ts`,
`geometryCacheKeys.ts`, `geometryCacheStoreLive.ts`,
`transformCollisionGeometryCore.ts`, or `transformCollisionGeometry.ts`
imports `IrregularNfpIfpControl`, checks `isCancelled`, or observes a
deadline. All three resolvers (`resolveNfpBoundary`, `resolveIfpBounds`,
`resolveTransformedCollisionGeometry`) are **synchronous, uninterruptible,
single-shot pure/cache functions** — the migration prompt's cooperative
checkpoint mechanism (`nfpCheckpoint`, `IrregularNfpIfpControl.checkpoint`)
lives one layer up, in `nfpIfpService.ts`'s `generatePlacementCandidatesUncached`
loop (`nfpIfpService.ts:280,307,315,329,354,409,429,432,456,496`, all **outside**
this cluster's scope), which calls `resolveNfpBoundaryFromServiceStore` /
`resolveIfpBoundsFromServiceStore` (thin wrappers over this cluster's
resolvers) **between** checkpoints, never mid-resolution. Because every
resolver in this cluster runs to completion synchronously and cannot be
interrupted mid-cache-operation, **a Rust port's threading/cache design
cannot introduce a mid-resolution suspension point that TypeScript never
had** — any await/yield point a Rust async implementation might introduce
inside `resolve_nfp_boundary`/`resolve_ifp_bounds`/`resolve_transformed_collision_geometry`
would be a new, TypeScript-incompatible cancellation observation point and
must be avoided (§12/§15, and directly relevant to migration-prompt §13.2's
"If parallel execution changes when a lookup occurs relative to a semantic
cancellation or deadline checkpoint, the parallel design is not yet valid").

## 11. Error paths

- **`CoreNfpFailure`** (`nfpBoundaryCore.ts:116-119`): `{ ok: false, message: string }`.
  Produced by: strict-boundary validation failures (fixed/moving/translated
  ring), `Minkowski sum`/`Minkowski edge merge`/`Minkowski edge arithmetic`
  non-finite-coordinate failures (`sumPoints`, `edgeVectors`, various message
  strings threaded through `computeRelativeNfpBoundaryReference`/`Linear`),
  and the fixed-translation non-finite failure in `translateNfpBoundary`
  (`:473-475`). All messages are plain English strings, not typed error
  codes, at this layer — the typed `IrregularGeometryInputError` wrapping
  happens one layer up in `nfpIfpService.ts:294-299,326`
  (`failInvalidGeometry('computeNfp', result.message)`), **outside this
  cluster**. This cluster's own error surface is therefore just
  `{ok:false, message}`/`{message}` discriminated-union shapes, never a
  `Data.TaggedError` instance.
- **`CoreIfpBoundsFailure`** (`ifpBoundsCore.ts:25-29`):
  `{ ok: false, kind: 'invalid' | 'infeasible', message: string }` — the one
  place in this cluster with a two-way error-kind discriminant (§9.2), mapped
  one layer up to either `IrregularGeometryInputError` (`kind: 'invalid'`) or
  `IrregularGeometryInfeasibleError` (`kind: 'infeasible'`) in
  `nfpIfpService.ts:241-248`.
- **`CoreTransformCollisionFailure`** (`transformCollisionGeometryCore.ts:27-30`):
  `{ ok: false, message: string }`, produced by `failure(message)`
  (`:184-186`) at four distinct call sites: source-boundary invalid (`:75`),
  non-finite transformed coordinate (`:82`), canonical-grid-overflow snap
  failure (`:88-90`), transformed-boundary invalid (`:96`). Mapped one layer
  up to `IrregularGeometryInputError` in both `geometryKernel.ts:189` and
  `transformCollisionGeometry.ts:50-56`.
- **No panics/thrown exceptions** in this cluster's normal operation —
  every failure path is an explicit discriminated-union return value, never
  a thrown `Error`. (TypeScript *can* throw on truly unexpected input
  shapes, e.g. if `points[index]` access patterns hit `undefined` in ways not
  already guarded — but every such access in this cluster is explicitly
  `undefined`-checked before use; grep confirms no unguarded array-index
  dereference feeds a `.x`/`.y` read in these seven files.)
- **Error provenance/context fields**: this cluster's error shapes carry only
  a free-text `message`, no `operation`/`category`/`preparedPieceId`-style
  structured context — that structured tagging is added by the calling layer
  (`nfpIfpService.ts`, `geometryKernel.ts`), per the migration prompt's
  error-mapping table (§16 of the prompt) which names
  `IrregularGeometryInputError` → `irregular_geometry_invalid` with
  `operation` context, and `IrregularGeometryInfeasibleError` (not in the
  prompt's mapping table verbatim — confirm this class's external mapping
  before porting; it's not one of the eight rows in the migration prompt's
  error table, see §15 open question).

## 12. JS-specific semantics hazards for a Rust port

1. **`Number.prototype.toString()` shortest-round-trip formatting**
   (`numberKey`/`numberIdentity`, §6/§7/§8) is the single highest-risk
   textual hazard in this cluster: every cache key and every ring fingerprint
   embeds `String(number)` output verbatim. V8's algorithm and Rust's default
   `f64` `Display`/`ryu`-based formatting are both "shortest round-trippable
   decimal" but are not certified byte-identical across the full `f64` domain
   (exponential-notation thresholds in particular: JS switches to exponential
   notation for magnitudes `< 1e-6` or `>= 1e21`; Rust's default `{}` never
   uses exponential notation at all, e.g. `format!("{}", 1e21)` in Rust prints
   a full 22-digit integer-like string, not `"1e+21"`). **A Rust port must
   implement a byte-exact reproduction of `ECMA-262 Number::toString`,
   not rely on Rust's default float formatting**, or every cache key
   (and hence every namespace's identity/hit-rate behavior, and the
   fingerprint's own re-validation triggering) silently diverges from
   TypeScript for any coordinate whose canonical decimal form falls in a
   divergent formatting regime.
2. **Signed-zero folding is applied inconsistently by design** (three
   independent copies of `Object.is(value,-0) ? '0'/0 : value/String(value)`,
   §7) — some paths fold `-0` into the *key string* only (`numberKey`), some
   fold it into the *stored coordinate value* (`normalizeNegativeZero` in
   `transformCollisionGeometryCore.ts`/`ifpBoundsCore.ts`), and the
   fingerprint (`numberIdentity`) folds it for *fingerprint-comparison*
   purposes only, without changing the ring's actual stored coordinates. A
   Rust port must replicate this **exact partition of where signed-zero
   folding does and does not happen**, not a single "normalize everywhere"
   pass, or it risks either (a) losing the ability to distinguish
   `transform.mirrored`-induced `-0` intermediate states that JS's specific
   call sites deliberately do *not* fold (there are none currently observed
   in this cluster, but the pattern is call-site-specific by design, not
   uniform) or (b) changing which cache keys collide.
3. **`WeakMap`-based, process-lifetime identity memoization**
   (`validatedRings`, §4/§9.4/§9.5) has no idiomatic Rust equivalent tied to
   object identity in the same way — Rust ownership makes most of the
   TypeScript hazard this memo defends against (iterator/index divergence on
   a *mutable, aliasable* array) structurally impossible for owned
   `Vec<Point>`/borrowed `&[Point]` data. A literal port (e.g., a global
   `HashMap<*const Point, ...>` keyed by raw pointer identity) would be
   `unsafe`, fragile (pointers can be reused after deallocation — a
   correctness bug, not just a style concern), and solves a problem Rust's
   ownership model likely does not have. This is a case where the *outcome*
   (avoid redundant O(n²) revalidation of the same ring content within a hot
   loop) must be preserved, but the *mechanism* almost certainly should not
   be ported literally — see §15's open question on whether Rust needs any
   such memo at all, or whether Rust's revalidation cost is negligible enough
   (or can be avoided architecturally, e.g. validate once at construction and
   carry a `is_valid: bool`/typed "already validated" wrapper) that the memo
   can be dropped as an implementation detail with no observable effect on
   any parity-gated output (cache values, telemetry, and control flow are all
   unaffected by whether this specific redundant-validation optimization
   exists — see next point).
4. **`Map` insertion order is a non-hazard for this specific cluster**
   (§5) — the backing store is never iterated for output, so Rust's
   non-deterministic-iteration `HashMap` is a safe structural substitute
   *for the backing store itself*, **as long as point-lookup semantics
   (`get`/`insert`/`remove`) are preserved exactly** and no future addition
   to this cluster starts iterating the map for anything semantic. This is
   one of the few clusters in the codebase where the migration prompt's
   general "never use raw `HashMap` iteration as an ordering source" warning
   (prompt §9) is **not** a live risk today, precisely because nothing here
   iterates it — but it must stay that way; any future Rust refactor that
   adds cache-content iteration (e.g., for a memory-budget eviction sweep,
   prompt §13.6) must not let iteration order leak into any parity-gated
   output.
5. **`JSON.stringify` array-of-strings serialization** (§8) — reproducible in
   Rust with a manual writer or `serde_json::to_string(&(namespace, parts))`,
   but must be verified byte-identical for the string-escaping edge cases
   (backslash, quote, control characters, lone surrogates) even though none
   are expected in practice for these specific field values (piece IDs,
   backend identifiers, sheet labels — user-controlled sheet `label` is the
   one field in this cluster's data that could plausibly contain arbitrary
   user text, via `InternalSheetSpec.label` feeding `sheet=${w},${h},${label}`
   in `makeInnerFitBoundsCacheKey`, `geometryCacheIdentity.ts:55`).
6. **Stable-sort reliance**: not present in this cluster's own code (§5) —
   `computeConvexHull`'s `sortedPoints = [...points].sort(...)`
   (`core/convexHullCore.ts:6-9`) is a callee used by `nfpBoundaryCore.ts`'s
   fallback hull construction, and relies on JS's ES2019+ guaranteed-stable
   `Array.prototype.sort`; ties in that comparator (`left.x !== right.x ?
   left.x - right.x : left.y - right.y`, which is a **total order with no
   actual ties possible** unless two points are coordinate-identical, in
   which case `deduplicateSortedPoints` immediately collapses them, `:10,18-26`)
   make stability moot in practice for this specific call, but a Rust port
   using `Vec::sort_unstable_by` instead of `Vec::sort_by` for this call
   would only be safe *because* the comparator has no real ties post-dedup —
   verify this invariant holds before assuming `sort_unstable` is
   interchangeable here.
7. **String comparison for the digest tie-break** (`canonicalPolygonDigest`'s
   `forward < reverse`, §6) is plain UTF-16 code-unit comparison in JS. Since
   both operands are built exclusively from `numberKey` output and fixed
   ASCII separators (`,`/`;`), every character is in the ASCII range and
   UTF-16 code-unit order coincides with byte order for this specific case —
   so Rust's `str`/`&[u8]` lexicographic `Ord` is safe here **only because**
   the input alphabet is provably ASCII-only; this is not a general
   "JS string comparison equals Rust string comparison" claim and must not be
   generalized to other clusters without the same ASCII-only proof.

## 13. Parallelism assessment

**Pure and stable-index-safe (good Rayon candidates in isolation):**
- `computeRelativeNfpBoundary`/`computeTransformedCollisionGeometry` proper
  (the *pure compute*, not the cache-aware wrapper) are side-effect-free
  functions of their inputs; independent pairwise NFP computations for
  distinct `(fixed, moving)` pairs, or independent transform computations for
  distinct `(geometry, transform)` pairs, have no data dependency on each
  other and could in principle be computed in parallel **before** any cache
  interaction, matching migration-prompt §14.1's "independent pairwise
  relative NFP computations after key deduplication" and "independent
  transform materialization by stable piece and transform index" candidates.
- Key construction (`makePairwiseNfpCacheKey`, `makeTransformCollisionGeometryCacheKey`,
  `makeInnerFitBoundsCacheKey`) is pure string-building with no shared state
  and is trivially parallelizable per input.

**Chronology-bound / must stay logically serial (or require careful
single-flight design, not naive parallel races):**
- The **cache read-decide-write sequence itself** (§9.1–9.3) is a
  read-then-conditionally-write critical section per key. Two threads racing
  on the *same* key (e.g., two placements both needing the NFP of the same
  fixed/moving pair — which is exactly the common case this cache exists to
  exploit, given the ~98% hit rate) must not both compute-then-both-`set`
  in a way that changes telemetry counts observably differently from a
  hypothetical serial run, given the migration prompt's requirement that
  "cache insertion race order never changes output, trace, checkpoint,
  ledger, or diagnostics that are parity-gated" (prompt §13.1). Because this
  cluster's `getPresent`/`setCalls`/`removeCalls` telemetry (§9.6) is
  explicitly documented as non-semantic/diagnostic-only, a Rust port has
  license to let *telemetry* counts differ under concurrency (the prompt
  allows "schedule-dependent telemetry values are compared only as
  measurements, never as parity fields", §13.7) — but the **published
  value** for a given key must be identical regardless of which thread wins
  the race (prompt §13.1: "A cache hit and a recomputation must return the
  same canonical immutable value... Cache insertion race order never changes
  output"). Since `computeRelativeNfpBoundary`/`computeTransformedCollisionGeometry`
  are pure functions of their inputs, this is achievable via either
  single-flight-per-key or "duplicate computation allowed, exact-key-equality
  publish, last/first writer is semantically irrelevant" — but the *decision*
  of which policy to use, and its interaction with this cluster's
  remove-then-set stale-eviction ordering (§9.1–9.3), must be designed
  explicitly (migration prompt §13.5), not assumed safe by default.
- The **`validatedRings` fingerprint memo** (§4/§9.4/§12.3) is a shared
  mutable side table with no natural sharding key beyond array identity — if
  ported as any kind of shared-across-threads structure it becomes a
  contention point disproportionate to its purpose (avoiding a redundant
  validation pass), and per §12.3 the underlying hazard it defends against
  may simply not exist in Rust's ownership model — the strong recommendation
  is to **not** port this memo as a literal shared cache at all, and instead
  either always revalidate (if benchmarks show the O(n²) cost is not
  dominant post-port, especially given `docs/research/trusted-ring-validation-memo.md:38-41`'s
  own admission that the tail of large rings, not the median, drives this
  cost — p90 = 28 vertices, p99 = 107 vertices) or carry a
  "validated-once-at-construction, immutable thereafter" typed wrapper that
  makes the memo's job structurally unnecessary. Either resolution is a
  **semantics-neutral internal implementation choice** as long as the
  *validation outcome* (accept/reject, and the reported winding) for every
  ring is unchanged, because the memo's presence/absence has zero effect on
  any of this cluster's cache keys, cache values, or telemetry counters
  (`getCalls`/`getPresent`/`setCalls`/`removeCalls` are all about the
  `GeometryCacheStore`, not about this separate `WeakMap`) — **this needs
  explicit user/orchestrator confirmation before a Rust implementer treats it
  as free to drop**, since the migration prompt's "absolute semantic
  preservation" framing (prompt §2) technically extends even to internal
  mechanisms unless *proven* unobservable, and this document's proof above,
  while thorough, should be independently re-verified against the full
  `nfpIfpService.ts` call graph (out of this cluster's primary scope) before
  final sign-off.
- **Compact vs. Compact Short Side sharing one cache instance per job**
  (§1) means any Rayon design must treat the *whole job* (both phases) as one
  coherent cache domain, not two separate domains that could be parallelized
  against each other — Short Side's directional geometry construction runs
  strictly after Compact's endpoint is settled (migration prompt §12,
  "Compact first selects... Short Side receives that settled partition") so
  there is no possible legitimate Compact/Short-Side cache-access race to
  design for in the first place; the cache is reused sequentially across
  phases, not contended between them.

## 14. Tests and gates covering this cluster

Grep-confirmed exhaustive list of files importing/exercising this cluster's
seven modules (`tests/unit/*.test.ts`, plus one gate script):

- `tests/unit/nfpBoundaryCore.test.ts` (220 lines, read in full) — pins exact
  cache-key JSON bytes for the pairwise-NFP namespace, exact
  miss/hit/stale/clear action-log ordering, no-cache-action-on-invalid-input,
  no-store-on-relative-construction-overflow, retained-relative-boundary-on-
  translation-overflow, and reference-vs-linear construction-algorithm parity.
- `tests/unit/ifpTransformCore.test.ts` (282 lines, read in full) — pins
  exact action-log ordering for `resolveTransformedCollisionGeometry` and
  `resolveIfpBounds` (miss, stale, invalid-before-cache, infeasible-after-get,
  overflow-after-get-no-store), and pins that hit results are the *identical
  object* (`Object.getPrototypeOf(first.value)).toBe(Object.prototype)`,
  plain-object, not domain-class, confirming this pure core layer never
  touches Effect/domain-class wrapping).
- `tests/unit/pureIfpTransformContract.test.ts` (410 lines, read in full) —
  the Effect-layer (`GeometryKernel`/`NfpIfpService`) equivalent of the above,
  additionally pinning the two golden cache-key byte strings (§8), the
  construction-inertness of the returned `Effect` (no cache action until the
  Effect is actually run — `pending = kernel.transformCollisionGeometry(input); expect(events).toEqual([]); yield* pending`,
  `:268-288,359-381`), and same-object-reference (`toBe`) preservation across
  a "second call is a hit" scenario at the Effect layer.
- `tests/unit/nfpBoundaryTrustedRings.test.ts` (225 lines, read in full) —
  the trusted-ring identity-memo behavioral contract at the
  `resolveNfpBoundary`/`isValidCachedNfpBoundary` level: repeat-resolution
  identity, persistent-rejection-of-invalid-input, revalidation-after-
  in-place-mutation (both invalid→valid and valid→invalid directions),
  equal-geometry-through-a-different-array-object still validates
  independently (no false-positive cross-array reuse), foreign/malformed
  cached values are always fully re-walked, and a previously-valid cached
  boundary is rejected once mutated in place.
- `tests/unit/ringFingerprintAccessPath.test.ts` (156 lines, read in full) —
  the index-vs-iterator access-path equivalence proof for the fingerprint
  guard specifically (§9.4/§12.3).
- `tests/unit/irregularGeometryCache.test.ts` (546 lines, read in full) — the
  highest-level integration suite: live `Effect`-provided `GeometryCache`
  behavior across all three namespaces simultaneously, telemetry-namespace
  counter assertions tied to exact call sequences (§9.6), transform-key
  separation by transform index, pairwise-NFP/IFP reuse-without-caching-
  invalid-geometry, relative-NFP sharing across canonically-equivalent
  geometry copies (§9.4 last paragraph), translation-without-recompute,
  cache-miss-on-any-of-{geometry, transform, settings}-change, cached-vs-
  uncached output equality, and stale-boundary eviction-on-invalid-cached-value.
- `tests/unit/nfpIfpTelemetry.test.ts` (120 lines, read in full) — the
  telemetry module's own unit contract in isolation from any cache/service
  wiring (disabled-is-inert, reset-on-enable, detached/sorted snapshots).
- `scripts/irregular-sheet-invariance.ts` (grep-level; `:1-5,600-643`) — the
  production gate script backing `pnpm gate:mixed61-compact`
  (`package.json:32`) and `pnpm corpus:sheet-invariance`
  (`package.json:31`); optionally enables this cluster's telemetry via
  `--capture-cache-telemetry` and writes a `cache-telemetry.json` sidecar,
  but the pass/fail gate itself does not assert on cache telemetry.

Not primary-scope for this cluster but touching it indirectly (excluded from
the above list, listed here for completeness since the original file grep
also matched them): `tests/unit/geometryBackendParity.test.ts`,
`tests/unit/transformGenerator.test.ts`, `tests/unit/nfpIfpService.test.ts` —
these exercise `nfpIfpService.ts`'s candidate-generation and free-material
logic, which *calls into* this cluster's resolvers as a dependency but whose
own primary subject (candidate point generation, transform generation) is a
different cluster's characterization responsibility.

No dedicated test file exists solely for `transformCollisionGeometry.ts`'s
`TransformCollisionGeometry.compute` facade specifically (its behavior is
exercised transitively wherever `computeTransformedCollisionGeometry` is
tested, since it's a thin wrapper) — see §15 open question on whether this
facade is even live.

## 15. Open questions and ambiguities

1. **Is `TransformCollisionGeometry.compute` (`transformCollisionGeometry.ts:15-32`)
   actually reachable from production code?** Every grep performed during
   this characterization shows the live `GeometryKernel.transformCollisionGeometry`
   service method (`geometryKernel.ts:179-190`) calling
   `resolveTransformedCollisionGeometry` (the **cache-aware** resolver)
   directly, not `TransformCollisionGeometry.compute` (which calls the
   **cache-bypassing** `computeTransformedCollisionGeometry` directly,
   `transformCollisionGeometry.ts:27`). If `TransformCollisionGeometry.compute`
   has no production caller, a Rust port should treat it as a redundant
   duplicate entry point (portable as a thin wrapper for test/API parity if
   any external consumer imports it, but not as a second live code path
   needing independent cache-semantics verification). **Action for the
   orchestrator**: run `grep -rn "TransformCollisionGeometry\b" src/ tests/`
   repository-wide (beyond this cluster's seven files) to confirm zero
   production imports before finalizing Rust scope for this symbol.
2. **Does `geometryCacheKeys.ts`'s parallel key-construction path
   (`pairwiseNfpCacheKey`, `transformCollisionGeometryCacheKey`,
   `innerFitBoundsCacheKey`) ever run on the live request-serving path, or is
   it test-and-`nfpIfpService.ts`-re-export-only?** This document found it
   consumed by `nfpIfpService.ts` only for the `DEFAULT_NFP_CONSTRUCTION_ALGORITHM`/
   `legalPlacementCandidateMemoKey` exports, not for the three `*CacheKey`
   functions themselves in that file's runtime logic (`nfpIfpService.ts`
   calls `resolveNfpBoundaryFromServiceStore`/`resolveIfpBoundsFromServiceStore`,
   which route through `core/nfpBoundaryCore.ts`/`core/ifpBoundsCore.ts`
   directly, not through `geometryCacheKeys.ts`'s wrappers). If confirmed
   test-only, a Rust port may implement one key-construction path instead of
   two, provided byte-identical output is proven for both call shapes it
   currently serves (domain-typed vs. `Internal*`-typed inputs) via a
   differential test before deletion of the duplication is considered "safe."
3. **Is the `validatedRings` `WeakMap` fingerprint memo (§9.4/§12.3/§13)
   semantically load-bearing beyond performance, or purely an internal
   optimization with zero externally observable effect?** This document's
   analysis concludes the latter (the memo never changes a validation
   *outcome*, only whether that outcome is recomputed or replayed, and
   nothing outside `validateStrictBoundaryOnce` observes whether a
   computation was memoized), but this conclusion should be independently
   re-verified — in particular, re-verify that no caller relies on the
   `WeakMap`'s *cross-job persistence* (§9.5) as an implicit warm-cache
   performance characteristic in a way that a production timeout/deadline
   budget (out of this cluster's scope) implicitly depends on. If truly
   unobservable, the orchestrator should explicitly rule that Rust need not
   reproduce this specific mechanism (only its *outcome-preserving*
   invariant: validation is exact and deterministic per ring content), per
   migration-prompt §2's requirement to prove unobservability before
   diverging.
4. **`IrregularGeometryInfeasibleError`'s external error-code mapping is not
   listed in the migration prompt's §16 mapping table.** This cluster
   produces the `kind: 'infeasible'` discriminant (`ifpBoundsCore.ts:87`)
   that `nfpIfpService.ts:241-247` wraps as `IrregularGeometryInfeasibleError`
   — but the prompt's error-mapping table (prompt §16) only lists eight rows,
   none named `IrregularGeometryInfeasibleError`. Before Rust implements this
   error path, confirm the correct external `AppErrorCode` for
   `IrregularGeometryInfeasibleError` against current
   `src/shared/protocol/errors.ts` (as the prompt itself instructs, §16,
   "Verify the table against... current source remains authoritative") —
   this document did not read that file as it is outside this cluster's file
   list, but flags the gap explicitly since it directly affects a Rust
   `IfpBoundsFailureKind::Infeasible` → external-code mapping decision.
5. **Confirm zero production `GeometryCache.clear()` call sites.** §9.5
   states no production code calls `clear()` based on the grep performed
   during this characterization (only test files call it). If a production
   caller exists elsewhere in the codebase outside this cluster's traced
   call graph (e.g., inside error-recovery or job-teardown logic this
   characterization did not read), the exact chronological position of that
   `clear()` call relative to in-flight work matters for a Rust port's
   cleanup-on-cancellation design (migration prompt §13.6, "clean up all
   cache state at job completion or cancellation"). Recommend a targeted
   repository-wide grep for `.clear` calls near worker-lifecycle/cancellation
   code before finalizing the Rust cache-teardown contract.
6. **No contradiction found between this cluster's source and the migration
   prompt's cited Mixed-61 cache statistics** (prompt §13.3's `266,977`/
   `262,166`/`4,811`/`98.2%` figures match
   `docs/research/trusted-ring-validation-memo.md:30-34` exactly). This
   document did not independently reproduce those numbers by running the
   gate with `--capture-cache-telemetry` (that would be a Stage-0 evidence
   task for the orchestrator's separate profiling workflow, not this
   characterization document), so the figures are reported as **documented,
   not independently re-measured, source truth** — flagged here per the
   task's instruction to surface any prompt-vs-source mismatch prominently;
   in this case there is no mismatch found, only an un-reproduced-by-this-
   agent measurement.
