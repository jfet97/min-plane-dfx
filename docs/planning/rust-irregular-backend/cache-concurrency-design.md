# Cache and Concurrency Design

Status: **implemented contract for Sections 9 and 10**. The job-local cache
architecture described here is implemented under
`crates/irregular-nesting-native/src/caches/`. The production geometry store
uses a finite 56 MiB deterministic charged LRU, and the free-material cache
uses a finite 8 MiB charged insertion-order FIFO. Cache mutation and telemetry
remain coordinator-only while Rayon workers perform pure deterministic
geometry computation.

Governing specifications are
`docs/history/prompts/fable5-rust-irregular-nesting-implementation.md` §13 and §14,
`PR27-REMEDIATION-PLAN.md` Sections 9 and 10, and `architecture.md` §3.10 and
§4.2. Characterization sources remain
`docs/planning/rust-irregular-backend/characterization/geometry-caches.md` and
`characterization/nfp-ifp.md`, plus the TypeScript cache implementation cited
throughout this document. TypeScript remains the semantic oracle and fallback;
the finite Rust cache policies may change only reuse and recomputation cost,
never externally observable nesting behavior.

This document owns the implemented cache and telemetry contract. Promotion
thresholds remain governed by `performance-contract.md`; retained Mixed-61
measurements and cap rationale are recorded in
`evidence/memory-cache-report.md`.

---

## 1. Cache namespace inventory

Four TS cache/memo instances are live on the production Compact and Compact
Short Side path. All four are constructed fresh per job (job-local; see §2).
Three share one physical backing `Map` (`GeometryCacheStore`); the fourth
(legal-candidate memo) is a separate `WeakMap`-scoped structure with its own
per-search-invocation granularity. A fifth structure, the module-level
`validatedRings` `WeakMap` fingerprint memo, is a process-lifetime,
non-job-scoped internal optimization with no cache-key/cache-value identity
of its own; it is documented in §1.5 and excluded from the Rust port's cache
architecture per the rationale there.

### 1.1 Pairwise relative-NFP cache — `pairwise-nfp-relative-v3`

**Identity.** Namespace constant `NFP_GEOMETRY_CACHE_NAMESPACE = 'pairwise-nfp-relative-v3'`
(`src/workers/irregular/core/nfpCacheKey.ts:4`). Key built by
`makePairwiseNfpCacheKey` (`nfpCacheKey.ts:31-47`) from:
`fixed-polygon=<canonicalPolygonDigest>`, `moving-polygon=<canonicalPolygonDigest>`,
`fixed-transform=<transformDigest>`, `moving-transform=<transformDigest>`,
then `geometrySettingsParts` (`flattening-sag`, `clearance-margin`, `backend`,
`backend-version`, the literal `offset-policy=clipper2-offset-v3-sharp-miter-scale-1000`),
then the literal `nfp-algorithm=convex-fixed-plus-negated-moving-relative-v3`,
then `nfp-construction=<constructionAlgorithm>` (`nfpCacheKey.ts:49-57,91-98,100-102`).
`canonicalPolygonDigest` (`nfpCacheKey.ts:59-74`) is **rotation- and
winding-invariant**: it picks the lexicographically-smallest-`(x,y)` start
vertex, builds both traversal directions' cyclic digest, and keeps whichever
plain-string comparison (`<`) is smaller. This is why geometrically identical
but differently-labelled placed pieces share one cache entry
(geometry-caches.md §2 "core/nfpCacheKey.ts", §6, nfp-ifp.md §9.A closing
paragraph). Golden byte string pinned by
`tests/unit/nfpBoundaryCore.test.ts:38-53` (reproduced in
geometry-caches.md §8).

**Legacy byte-key materialization.** `serializeGeometryCacheKey(key)` =
`JSON.stringify([key.namespace, key.parts])` (`core/geometryCacheStore.ts:13-15`).
This string is the literal `Map<string, unknown>` key. A Rust port's internal
key representation may be an interned/hashed struct (prompt §13.4) but must
prove exact-key equality against this byte-string, not merely "looks
equivalent", and must be able to materialize the identical byte string when a
differential test needs to compare it (`nfpBoundaryCore.test.ts:38-53` pins
literal bytes).

**Value shape.** `InternalPolygon` (`{ points: InternalPoint[] }`) — the
**relative** (untranslated, fixed-piece-agnostic) NFP boundary
(`nfpBoundaryCore.ts:148-163`). Translation by the current fixed piece's
placement happens on every call, after lookup, and is **never cached**
(`translateNfpBoundary`, `nfpBoundaryCore.ts:465-482`).

**Exact TS access sequence** (`resolveNfpBoundary`, `nfpBoundaryCore.ts:125-167`,
geometry-caches.md §9.1, nfp-ifp.md §9.A):
1. Validate fixed ring (`validateStrictBoundaryOnce`, `:130-133`) — fail before
   any key/cache action; **zero cache actions** on failure.
2. Validate moving ring (`:135-136`) — same short-circuit.
3. Build key (`:138-147`).
4. `cache.get(key)` — exactly one `get` regardless of outcome (`:148`).
5. `isValidCachedNfpBoundary(cached)` (`:151` → `:249-253`: `points.length >= 3`
   AND re-`validateStrictBoundaryOnce`):
   - **Valid hit**: use directly. No recompute, no `set`.
   - **Stale** (`cached !== undefined`, invalid): `cache.remove(key)` (`:154`)
     strictly before recompute and `cache.set` (`:161-162`).
   - **Miss**: recompute, `cache.set` on success — no `remove`.
   - **Recompute failure**: return failure; **cache is never written** (`:160`).
6. `translateNfpBoundary(...)` (`:165`) runs unconditionally after the cache
   decision, on every call, hit or miss; it never touches the cache. A
   translation failure here does **not** roll back the already-published
   relative-boundary cache entry from step 5 — the shared relative NFP stays
   valid for other fixed placements of the same canonical-equivalent geometry
   even though *this* call returns failure (`nfpBoundaryCore.test.ts:115-136`,
   geometry-caches.md §9.1 point 6). **A Rust port must reproduce this
   asymmetry exactly**: publish-on-recompute-success is unconditional on the
   *relative* computation succeeding, not on the whole `resolveNfpBoundary`
   call succeeding.

**Internal fast-path bypass.** Production never calls the public Effect
`computeNfp` API inside candidate generation; it calls
`resolveNfpBoundaryFromServiceStore` (`nfpIfpService.ts:143-150`), which calls
`resolveNfpBoundary` directly, once per placed piece inside the
`for (const placed of input.placed)` loop (`nfpIfpService.ts:314-329`),
bracketed by `'placed-nfp'` checkpoints immediately before (`:315`) and after
(`:329`) each iteration (nfp-ifp.md §10 items 3-4). The public `computeNfp`
Effect wrapper (`nfpIfpService.ts:113-141`) is reached only from
`intrinsicPeriodicCells.ts:466,1046` (nfp-ifp.md §1), i.e. only inside the
periodic-cell archive lane, not inside the hot candidate-generation loop.
Rust must preserve both call shapes reaching the identical resolver logic
(one synchronous, one Effect-wrapped) with byte-identical cache behavior.

**Measured reuse (Mixed-61 `2000x2700`, one gate run):** 266,977 lookups /
262,166 present / 4,811 stores, 98.2% present rate
(`docs/research/trusted-ring-validation-memo.md:30-34`, matched by prompt
§13.3 and re-confirmed in geometry-caches.md §1). This is the namespace whose
reuse must survive concurrency (§3 below).

### 1.2 Transformed-collision-geometry cache — `transform-collision-v1`

**Identity.** Namespace constant `TRANSFORM_GEOMETRY_CACHE_NAMESPACE = 'transform-collision-v1'`
(`core/geometryCacheIdentity.ts:13`). Key built by
`makeTransformCollisionGeometryCacheKey` (`geometryCacheIdentity.ts:34-48`)
from a `collisionGeometryDigest` (folding `sourcePieceId`, `sourceBounds`,
`placementReference`, `convexHull.points`, `collisionPolygon.points` — **not**
`sampledPoints`, geometry-caches.md §3), the raw (unnormalized)
`transformDigest` (`index,rotation,mirrored,reason` — see §1.6 signed-zero/
transform-identity notes below), then `geometrySettingsParts`. Golden byte
string pinned by `tests/unit/pureIfpTransformContract.test.ts:184-189`
(geometry-caches.md §8).

**Value shape.** Whatever `materialize()` produces
(`transformCollisionGeometryCore.ts:47-49,60-62`); in production this is
`toDomainTransformedCollisionGeometry`
(`transformCollisionGeometry.ts:35-48`), a **domain-class instance**, unlike
the plain-object values in namespaces 1.1/1.3. A Rust port must preserve the
semantic content (fields), not "is it a class instance" — but must not assume
all three `GeometryCacheStore` namespaces store structurally-identical value
kinds (geometry-caches.md §3).

**Exact TS access sequence** (`resolveTransformedCollisionGeometry`,
`transformCollisionGeometryCore.ts:38-63`, geometry-caches.md §9.3):
1. Build key (`:51`) — **no pre-key validation step**, unlike NFP/IFP; the
   first cache action is always the `get` (confirmed
   `ifpTransformCore.test.ts:136-161`: an invalid-input case still shows
   exactly one `get` action; the failure originates inside
   `computeTransformedCollisionGeometry` after the lookup, not before it).
2. `cache.get(key)` (`:52`).
3. `isValidCachedTransformedCollisionGeometry(cached, input)` (`:53` →
   `:115-137`): exact-`===` field chain on `sourcePieceId`, `sameTransform`
   (four exact `===` on `index`/`rotationDeg`/`mirrored`/`reason` — **no
   tolerance on `rotationDeg`**, so `0` and `360` are different keys even
   though the geometric transform they produce is identical; §1.6),
   `polygon.points.length >= 3`, re-`validateStrictBoundary`, then exact
   `===` equality of all four recomputed bounds against the cached `.bounds`.
   - **Hit**: return cached value directly. No `set`. Critically: **no call
     to `materialize()`** on a hit (`:60` only runs on miss/stale) — this is
     why two `get`s can produce one `set` and an identical object reference
     on the second call (`toBe`, not just `toEqual`,
     `irregularGeometryCache.test.ts:267,321-348`).
   - **Stale**: `cache.remove(key)` (`:57`) strictly before compute,
     `materialize`, `cache.set` (`:58,60,61`).
   - **Miss**: compute, materialize, `cache.set` — no `remove`.
4. **Compute failure** (source-boundary invalid, non-finite transformed
   coordinate, canonical-grid-overflow snap failure, or transformed-boundary
   invalid — four distinct failure sites, `transformCollisionGeometryCore.ts:75,82,88-90,96`):
   return failure; **cache is never written**. This happens *after* the
   single required `get` — the file's own doc comment names this
   "key/get-before-validation ordering" (`transformCollisionGeometryCore.ts:37`).

**Measured reuse (Mixed-61 gate run):** 10,028 lookups / 9,540 present / 488
stores (`docs/research/trusted-ring-validation-memo.md:30-34`), ≈95.1%
present rate.

### 1.3 Rectangular inner-fit-bounds (IFP) cache — `sheet-ifp-v1`

**Identity.** Namespace constant `IFP_GEOMETRY_CACHE_NAMESPACE = 'sheet-ifp-v1'`
(`geometryCacheIdentity.ts:14`). Key built by `makeInnerFitBoundsCacheKey`
(`geometryCacheIdentity.ts:51-62`) from `sheet=<w>,<h>,<label>` (includes
`label`, unlike the legal-candidate memo key — §1.4), `moving-piece=<id>`,
`moving-transform=<digest>`, `moving-polygon=<digest>`,
`ifp-operation=rectangular-sheet-vertex-bounds`. Golden byte string pinned by
`tests/unit/pureIfpTransformContract.test.ts:184-189`.

**Value shape.** `InternalIfpBounds<TPieceId, TSheet>`
(`{ sheet, movingPieceId, bounds }`, `internalGeometry.ts:61-68`). The
cached `TransformedCollisionGeometry.bounds` field is explicitly **not**
trusted as an input to this key or its validation — a stale cache "must not
enlarge the IFP" (`nfpIfpService.ts:213-218` doc comment,
geometry-caches.md §3).

**Exact TS access sequence** (`resolveIfpBounds`, `ifpBoundsCore.ts:37-59`,
geometry-caches.md §9.2, nfp-ifp.md §9.B):
1. `ConvexPolygonValidation.validateStrictBoundary(input.moving.polygon.points)`
   (`:45`) — fail before key/cache; **zero cache actions**.
2. Build key (`:48`).
3. `cache.get(key)` (`:49`) — exactly one `get`.
4. `isValidCachedIfpBounds(cached, input)` (`:50` → `:100-123`): re-derives
   `movingBounds` from the **live** input polygon (never from anything
   cached) and requires exact equality of the cached bounds against
   `{-movingBounds.minX, -movingBounds.minY, sheet.width - movingBounds.maxX,
   sheet.height - movingBounds.maxY}` plus `movingPieceId`/`sheet.width`/
   `sheet.height` equality and finiteness.
   - **Hit**: return directly.
   - **Stale**: `cache.remove(key)` (`:54`) before recompute + `cache.set` (`:57`).
   - **Miss**: recompute + `cache.set` — no `remove`.
5. **Two distinct failure kinds after the `get`, both without a `set`**:
   `kind: 'invalid'` (arithmetic overflow, `:78-85`) and
   `kind: 'infeasible'` (piece cannot fit sheet even with finite arithmetic,
   `:86-89`). This 3-way split — `0 gets` (pre-cache validation failure) /
   `1 get, no store` (post-cache invalid or infeasible) / `1 get + set`
   (success) — is a precise contract callers branch on differently
   (`nfpIfpService.ts:283-306`: `'invalid'` fails the whole candidate call
   with `IrregularGeometryInputError`; `'infeasible'` is swallowed into an
   empty candidate list, never an error — nfp-ifp.md §11). **A Rust port's
   error-kind enum must preserve this exact three-way split and the
   invalid-vs-infeasible production-swallowing asymmetry.**

**Internal fast-path bypass.** Production never calls the public Effect
`computeIfpBounds` API (zero production call sites, nfp-ifp.md §1/§11); it
calls `resolveIfpBoundsFromServiceStore` (`nfpIfpService.ts:253-264`), which
calls `resolveIfpBounds` directly, once per `generatePlacementCandidatesUncached`
invocation (`nfpIfpService.ts:281-286`), **except** when
`input.candidateDomain === 'sheetless-nfp'`, which skips IFP resolution
entirely (`nfpIfpService.ts:279-282`).

### 1.4 Legal-placement-candidate memo — `legal-placement-candidates-v1`

**Identity — structurally different from 1.1–1.3.** This memo is **not**
stored in `GeometryCacheStore`'s backing `Map`. It lives in a
`WeakMap<IrregularNfpIfpCandidateMemoScope, Map<string, CachedLegalCandidateEntry>>`
named `candidatesByScope`, closed over inside `makeGeneratePlacementCandidates`
(`nfpIfpService.ts:611-614`, confirmed by direct read for this document).
Key built by `legalPlacementCandidateMemoKey`
(`src/workers/irregular/geometryCacheKeys.ts:77-106`, confirmed by direct
read for this document): namespace literal `legal-placement-candidates-v1`
prepended into a `JSON.stringify([...])` array containing sheet identity
(`sheet=deferred` for `candidateDomain === 'sheetless-nfp'`, else
`sheet=<w>,<h>` — **`label` intentionally omitted**, unlike 1.3's IFP key,
geometry-caches.md §8/nfp-ifp.md §15 item 5), a `|`-joined ordered list of
`<polygonDigest>@<translationDigest>` per placed piece **in `input.placed`
array order** (not sorted — order-sensitive by design), the moving polygon
digest, moving bounds digest, geometry settings parts, construction algorithm,
candidate pruning mode, and candidate domain. **This key intentionally omits
`moving.sourcePieceId`/`moving.transform`** — candidate *points* are pure
geometry and do not depend on which piece/transform index produced them
(nfp-ifp.md §9.C).

**Value shape.** `CachedLegalCandidateEntry = { candidates: ReadonlyArray<{point, diagnostics}>, provenance?: NfpIfpCandidateProvenance }`
(`nfpIfpService.ts:702-705`, confirmed by direct read). On restore
(`restoreCachedLegalCandidates`, `nfpIfpService.ts:716-729`, confirmed by
direct read), `pieceId`/`transform` are **re-stamped from the current call's**
`input.moving`, not from whatever call originally populated the entry — this
is the mechanism that makes the `sourcePieceId`/`transform` omission from the
key safe.

**Exact TS access sequence** (`service()` inner function inside
`makeGeneratePlacementCandidates`, `nfpIfpService.ts:625-692`, confirmed by
direct read; nfp-ifp.md §9.C):
1. If `input.candidateMemoScope === undefined`: **bypass entirely** — no
   lookup, no publish, `NfpIfpTelemetry.recordMemoBypass()`, call
   `generatePlacementCandidatesUncached` directly (`:631-639`).
2. Otherwise get-or-create the scope's inner `Map` (`:642-646`).
3. Build key (`:647`).
4. Lookup (`:648`).
5. **Hit-acceptance rule is provenance-aware, not just presence-aware**: a
   hit is used only if `cached !== undefined && (input.onCandidateProvenance === undefined || cached.provenance !== undefined)`
   (`:649-652`). A caller that wants provenance cannot be served by an entry
   cached without provenance capture — that case is logged as
   `'provenance-miss'` and treated as a miss for control flow even though
   `cached` is technically present.
6. **On accepted hit**: still runs exactly one
   `nfpCheckpoint(input.control, 'candidate-points')` (`:654`) before
   returning — a cooperative cancellation/deadline observation point is
   preserved even on a full memo hit.
7. **On miss/provenance-miss**: call `generatePlacementCandidatesUncached`,
   then `Effect.tap` publishes to the memo **only on success**
   (`Effect.tap` never runs on the failure channel) — a failed/aborted
   computation never populates the memo (`:683-690`).

**Lifetime.** `IrregularNfpIfpCandidateMemoScope` instances are constructed
fresh per decoder/search invocation at every production call site
(`intrinsicStrictDecoder.ts:471`, `intrinsicCapacitySearch.ts:450`, and
others — nfp-ifp.md §4, capacity-search.md §9 "IrregularNfpIfpCandidateMemoScope").
capacity-search.md §9 confirms this concretely for the capacity lane: a fresh
scope is built once per `runIntrinsicCapacityColdSearch` invocation, so
**candidate memoization is not shared across cold/warm/quality lanes or
across checkpoint resumes** — each invocation, including each bounded 1-depth
resume step of a warm/quality lane, gets a brand-new empty scope. This is a
strong, explicit signal for Rust cache granularity: **this memo is
per-search-invocation, not per-job**, unlike namespaces 1.1–1.3.

### 1.5 `validatedRings` ring-validation fingerprint memo — excluded from the Rust cache design

Module-level `WeakMap<object, {fingerprint, validation}>`
(`nfpBoundaryCore.ts:31-37`), keyed by the exact `points` array **object
identity** (not job-scoped — it is process-lifetime, surviving across worker
requests within one worker thread; geometry-caches.md §9.5). Its sole purpose
is to avoid re-running `ConvexPolygonValidation.validateStrictBoundary`'s
O(n²) self-intersection check on a ring whose content (exact per-coordinate
identity, folding `-0`→`0`) has not changed since the last call
(`validateStrictBoundaryOnce`, `nfpBoundaryCore.ts:39-55`; exact mechanism in
geometry-caches.md §9.4). It is provably transparent: every branch returns
exactly what a direct `validateStrictBoundary` call would return; nothing
outside `validateStrictBoundaryOnce` observes whether a result was memoized
(geometry-caches.md §4, §12 point 3, §15 item 3).

**Rust disposition: do not port this memo as a shared/concurrent cache
primitive.** Rust's ownership model does not have the mutable-aliased-array
iterator/index divergence hazard this memo defends against (geometry-caches.md
§12 point 3), and a literal port (e.g. a `HashMap` keyed by raw pointer
identity) would require `unsafe` and a correctness-fragile "pointer reused
after deallocation" hazard to solve a problem Rust does not have. The
*outcome* this memo preserves — validation is exact and deterministic per
ring content, and repeated calls on the same content return the same result —
is preserved automatically by making `validateStrictBoundary` a pure function
called wherever TS calls it (with or without memoization). The implemented Rust backend does not port this memo as a shared or
concurrent cache. Validation remains exact and deterministic per ring content.
Any future job-local content memo would be a separately measured optimization,
not a requirement for cache or output parity.

### 1.6 Cross-namespace hazards every namespace inherits

These are namespace-agnostic hazards documented once here because they gate
every namespace's Rust key/value implementation, not because they belong to
one namespace:

- **`numberKey`/`numberIdentity`** (`Object.is(value, -0) ? '0' : String(value)`,
  duplicated verbatim across `nfpCacheKey.ts:104-106`,
  `geometryCacheIdentity.ts:139-141`, `geometryCacheKeys.ts:158-160`,
  `nfpBoundaryCore.ts:86-88`) folds signed zero into the **key string only**,
  never the stored coordinate. Number-to-string rendering for the non-zero
  case is JS `Number.prototype.toString()`'s shortest-round-trip algorithm —
  per rulings R7, Rust must use the `ryu-js` crate (already a pinned
  dependency, `architecture.md` §2.2) for every namespace's key/digest
  construction, differentially verified against negative zero, exponent
  thresholds, and non-integer fixture values.
- **`sameTransform`** (`geometryCacheIdentity.ts:86-96`) uses raw,
  **unnormalized** `rotationDeg` for cache-key/cache-validity purposes even
  though `normalizeRotationDegrees` treats `0` and `360` as the identical
  geometric transform elsewhere (`transformCollisionGeometryCore.ts:146-149`).
  Namespace 1.2's key and validity check must use the raw value, not the
  normalized one — do not "fix" this into consistency (geometry-caches.md §6).
- **Signed-zero normalization is applied inconsistently by design** — three
  independent copies of the same two-line function (`numberKey`, key-only;
  `normalizeNegativeZero` in `transformCollisionGeometryCore.ts:180-182` and
  `ifpBoundsCore.ts:129-131`, stored-value-folding) apply at different call
  sites for different purposes. A Rust port must replicate the exact
  partition of where folding does and does not happen, not a single
  "normalize everywhere" pass (geometry-caches.md §7, §12 point 2).
- **`JSON.stringify` array-of-strings key serialization** is the entire
  legacy byte-key contract for namespaces 1.1–1.3 (`core/geometryCacheStore.ts:13-15`)
  and namespace 1.4 uses the identical `JSON.stringify([...])` shape directly
  (`geometryCacheKeys.ts:95-105`). A Rust key type may use any internal
  representation but must be able to reproduce this exact byte string on
  demand for differential tests, and must resolve key equality by exact
  equivalence to this byte-string identity, not by a weaker structural
  approximation (prompt §13.4).

---

## 2. Job-local ownership

**This is already the implemented TS behavior, not a target to build.**
`makeGeometryCacheStore()` (`geometryCacheStoreLive.ts:9-30`, confirmed by
direct read) constructs a brand-new `Map` on every call, called exactly once
per `GeometryCacheLive`/`GeometryCacheInMemory` layer construction
(`services.ts:436-448`), which happens exactly once per worker request
(`nesting.worker.ts:377-397`). geometry-caches.md §1 independently confirms
"all three caches in this cluster are live on the production Compact and
Compact Short Side path, and Compact and Short Side share exactly one cache
instance per worker job" — Short Side's directional construction runs
strictly after Compact's endpoint settles (prompt §12), so there is no
legitimate Compact/Short-Side cache race to design for; the cache is reused
sequentially across phases, not contended between them (geometry-caches.md
§13 closing bullet).

The legal-candidate memo (§1.4) is **finer-grained than job-local**: it is
per-search-invocation (fresh `IrregularNfpIfpCandidateMemoScope` per
`runIntrinsicCapacityColdSearch` call, per decoder invocation, etc.). A Rust
port must not widen this to job-scope — capacity-search.md §9 states this
explicitly as "a strong signal about the intended cache granularity for a
Rust port."

**Implemented Rust ownership.**

- One owned `GeometryCacheStore` is constructed at the top of
  `boundary::run_job` and threaded mutably through coordinator code. It is
  job-local, never process-global, and never shared across jobs.
- One `FreeMaterialCache` is also owned per job. Legal-candidate memo scopes
  keep their TypeScript-equivalent per-search-invocation lifetime.
- Rayon workers receive immutable inputs, compute pure geometry values, and
  return results to the coordinator. Only the coordinator performs cache
  lookup validation, recency updates, removal, admission, and telemetry changes.
- No cache namespace gains cross-job reuse. The TypeScript process-lifetime
  `validatedRings` optimization is not widened into shared Rust state.

**Cleanup on completion, cancellation, and panic.**

- **Normal completion and typed error**: before diagnostics are published,
  `boundary::run_job` calls explicit clear-and-shrink cleanup on the geometry
  and free-material caches. Current bytes and entries become zero. Peak and
  cumulative counters remain available in the diagnostic sidecar. The owned
  values are then dropped when the job frame returns.
- **Cooperative cancellation**: cancellation is observed only at the established
  semantic checkpoints, never in the middle of a cache transaction. The job
  returns through the normal completion path, including explicit cache cleanup
  and diagnostic publication.
- **Outer worker termination**: terminating the worker process relies on process
  teardown, matching the existing TypeScript supervisor boundary.
- **Panic**: panic containment unwinds owned job-local values. Normal Rust drop
  releases cache storage; there is no cross-job lock poisoning or retained
  process-global cache state.

---

## 3. Implemented per-namespace concurrency policy

The implemented policy is the same for all three geometry-cache namespaces:
`pairwise-nfp-relative-v3`, `transform-collision-v1`, and `sheet-ifp-v1`.

1. The coordinator owns one mutable `GeometryCacheStore` for the whole job.
2. Cache probes, validity checks, cloning hits, stale removal, admission,
   replacement, eviction, recency updates, and telemetry updates execute
   serially on the coordinator.
3. Rayon workers receive immutable inputs and compute pure geometry values.
   They do not hold a cache reference and cannot publish directly.
4. Computed values return in stable ordinal order. The coordinator publishes
   them serially, preserving deterministic cache and externally visible order.
5. The NFP prepass uses `GeometryCacheProbe` to validate a hot value by borrow.
   The ordinary resolver remains the only path that clones a cached polygon.

This policy intentionally does not use a sharded shared cache, concurrent map,
single-flight markers, shard locks, `Arc`-stored cache values, or thread-local
front caches. Those alternatives were evaluated during design, but the current
architecture avoids their synchronization and scheduling surfaces entirely.
The geometry cache therefore needs no atomic counters, lock-wait telemetry, or
cross-thread duplicate-publication reconciliation.

### 3.1 Namespace-specific behavior

- **Pairwise NFP**: the coordinator performs the non-cloning validity prepass,
  batches only cold pure computations into Rayon, then publishes successful
  boundaries serially in original request order.
- **Transformed collision geometry**: normal coordinator resolver calls use the
  shared job-local store. Any parallel caller must batch pure transformation
  work and return it for serial publication rather than sharing the store.
- **Sheet IFP bounds**: lookups and publication remain coordinator-owned. The
  fixed-size value still receives a conservative retained charge.
- **Legal-candidate memo**: this is not part of the shared geometry store. Its
  TypeScript-equivalent per-search-invocation lifetime remains local and
  single-writer.

### 3.2 Determinism and performance evidence

The release cap matrix runs default, effectively unlimited, tight nonzero, and
zero caps at one and two threads and compares timing-normalized result bytes.
It proves that eviction and rejection affect only recomputation cost. Full
Mixed-61 default-versus-unlimited profiling retains the normalized SHA-256,
hit and miss counters, charged peaks, runtime, and process RSS in
`evidence/memory-cache-report.md`.

Schedule-sensitive diagnostic values are measurements, not parity fields.
Semantic output, canonical hashes, checkpoints, histories, traces, ledgers,
callback order, and typed errors remain exact parity surfaces.

---

## 5. Memory

**Bounds.** Per prompt §13.6 ("default to job-local ownership... enforce a
documented memory cap... record peak bytes and entry counts"), each of the
three `GeometryCacheStore` namespaces and the legal-candidate memo is bounded
implicitly by job-local lifetime (§2) — there is no cross-job growth to
bound. Within one job, the *number of distinct keys* per namespace is bounded
by the job's own input size (piece count, transform-candidate count, and the
number of distinct canonical-shape/transform pairs that actually occur during
search — not an independent unbounded dimension), matching TS's own
unbounded-but-input-proportional `Map` growth (TS never evicts these three
namespaces for memory reasons today; the only `remove` calls are the
stale-eviction branch of §1.1–1.3's own access sequences, which is a
correctness operation, not a memory-management one). A Rust port that adds a
memory cap where TS has none is a **new behavior** and must satisfy prompt
§13.6's "a missing value may cost time but may not alter behavior" — i.e.
eviction may only ever turn a would-be-hit into a miss (paying recomputation
cost), never change what value is eventually returned, never change control
flow, and never be a substitute for actually bounding per-job memory some
other way (e.g. rejecting jobs with implausible piece counts before they
reach this cluster, which is out of this cluster's scope).

**Charged-byte accounting.** Per prompt §13.7, every publication supplies a
conservative retained-value charge. The store adds retained key, namespace,
entry, recency-node, and hash-container overhead with checked or saturating
arithmetic. It tracks current and peak charged bytes globally and by namespace.
These values are diagnostic only and are never read by semantic control flow.

**Finite deterministic eviction.** The production geometry store has a 56 MiB
job-local cap and uses deterministic LRU order. A replacement is planned before
mutation. An entry larger than the whole cap is rejected without evicting
unrelated entries or failing the job. Otherwise, the coordinator evicts the
oldest entries until the new charge fits, then publishes it. Eviction can only
turn a would-be hit into recomputation; it cannot change the computed value,
ordering, callbacks, or result DTO. Cache mutation and recency updates remain
coordinator-only. Rayon workers perform pure geometry computation and publish
nothing directly.

After size-based eviction or stale removal, the store compacts retained
recency storage and shrinks the backing map so released container capacity is
not omitted from accounting. Normal completion explicitly clears and shrinks
all retained cache storage before taking the final diagnostics snapshot.
Current bytes and entries are therefore zero after cleanup, while peaks and
cumulative counters remain available as evidence. Panic unwind relies on
ordinary Rust ownership drop.

---

## 6. Required cache telemetry (prompt §13.7)

One concrete Rust struct, integer counters only, non-semantic sidecar. Per
prompt §17/§13.7: this struct is never part of the job's result DTO, never
hashed, never persisted into `NestingOptions`, sub-run settings, checkpoints,
history frames, decision traces, or protocol progress events — it is
returned only through the diagnostic channel `architecture.md` §4.5 already
establishes as a structurally separate return field from `boundary::run_job`.

```rust
// crates/irregular-nesting-native/src/caches/telemetry.rs
// Non-semantic diagnostic sidecar only (prompt §13.7, §17). Never read by
// control flow. Never part of the job result DTO (architecture.md §4.5).

use std::collections::BTreeMap;

use serde::Serialize;

/// One namespace's counters. `namespace` is a stable string identifier
/// matching the TS namespace constants verbatim (e.g. "pairwise-nfp-relative-v3")
/// so evidence can be cross-referenced against the TS baseline by name.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheNamespaceTelemetry {
    /// Every `get` call, hit or miss (TS: `getCalls`).
    pub lookups: u64,
    /// Lookups that resolved to a valid published value. Rust separates the
    /// TypeScript `getPresent` count into valid `hits` and
    /// `stale_detections`.
    pub hits: u64,
    /// Lookups that found no usable entry and require fresh computation.
    pub misses: u64,
    /// Successful publications (TS: `setCalls`).
    pub stores: u64,
    /// Lookups whose cached value failed re-validation (TS: `getPresent`
    /// entries that are stale, i.e. `isValidCached*` returned false).
    pub stale_detections: u64,
    /// Evictions performed as a direct result of a stale detection (TS:
    /// `removeCalls`; equals `stale_detections` in a correct implementation,
    /// tracked separately to catch a design bug if they ever diverge).
    pub stale_removals: u64,
    /// Reserved diagnostic from the evaluated concurrent-cache designs.
    /// Always `0` under coordinator-only cache mutation.
    pub duplicate_computations: u64,
    /// Reserved single-flight diagnostic. Always `0` because the implemented
    /// cache has no in-flight markers or waiters.
    pub single_flight_waits: u64,
    /// Reserved shard-lock timing. Always `0` because no shard locks exist.
    pub shard_lock_wait_nanos: u64,
    /// Reserved shard-lock contention count. Always `0`.
    pub shard_lock_contended_acquisitions: u64,
    /// Reserved front-cache count. Always `0` because no front cache exists.
    pub front_cache_hits: u64,
    /// Hits served by the coordinator-owned geometry backing store.
    pub backing_cache_hits: u64,
    /// Typed hits that cloned a cached value for the normal resolver.
    pub cloning_hits: u64,
    /// Finite charged-byte capacity for the shared backing store.
    pub cap_bytes: u64,
    /// Entries admitted after their retained charge fit the finite budget.
    pub admissions: u64,
    /// Successful publications that replaced an existing key.
    pub replacements: u64,
    /// Entries removed by deterministic size-based LRU eviction.
    pub evictions: u64,
    /// Charged bytes released by size-based evictions.
    pub evicted_bytes: u64,
    /// Publications rejected because one entry exceeded the whole cap.
    pub oversized_rejections: u64,
    /// Current entry count for this namespace at snapshot time.
    pub entries: u64,
    /// Current conservatively charged bytes for this namespace.
    pub approx_bytes: u64,
    /// Peak conservatively charged bytes observed during the job.
    pub peak_bytes: u64,
    /// Cumulative pure-compute time in nanoseconds. Currently zero because
    /// cache callers do not clock resolver work into this sidecar.
    pub computation_time_nanos: u64,
}

/// One job's complete cache telemetry snapshot. Namespace keys are stable
/// strings matching the TS namespace constants; `BTreeMap` (not `HashMap`)
/// is used only so a printed/serialized snapshot has deterministic key
/// order for human review — this ordering is diagnostic convenience, not a
/// parity requirement (contrast with prompt §9's ordering rules, which
/// govern canonical/semantic output, not this sidecar).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheTelemetrySnapshot {
    pub namespaces: BTreeMap<String, CacheNamespaceTelemetry>,
    /// Finite charged-byte cap for the shared geometry backing store.
    pub cap_bytes: u64,
    /// Current charged bytes across every geometry namespace.
    pub current_bytes: u64,
    /// Highest charged-byte total reached during this job.
    pub peak_bytes: u64,
    /// Cumulative admitted publications.
    pub admissions: u64,
    /// Cumulative publications that replaced an existing key.
    pub replacements: u64,
    /// Cumulative deterministic size-based evictions.
    pub evictions: u64,
    /// Cumulative charged bytes released by size-based evictions.
    pub evicted_bytes: u64,
    /// Cumulative single-entry rejections for exceeding the cap.
    pub oversized_rejections: u64,
    /// Number of distinct `GeometryCacheStore`-equivalent instances
    /// constructed during this process's lifetime that this snapshot
    /// aggregates over. In production this is always 1 per job (§2); a
    /// value other than 1 in a differential/stress-test harness is itself
    /// a testable invariant, mirroring TS's `cacheInstances` counter
    /// (`nfpIfpTelemetry.ts`, asserted `=== 1` per job by
    /// `irregularGeometryCache.test.ts:199,276`).
    pub cache_instances: u64,
}
```

Namespace strings populated in `CacheTelemetrySnapshot.namespaces` are
`"pairwise-nfp-relative-v3"`, `"transform-collision-v1"`, and
`"sheet-ifp-v1"`. Legal-candidate memo counters are recorded separately in
`NfpIfpTelemetry`; they are not part of the geometry-cache snapshot.

**Collection cost and ownership.** Every counter is a plain `u64` because the
coordinator is the only cache owner and mutator. Rayon workers compute pure
geometry values and return them for serial publication; they do not touch cache
state or telemetry. Counter updates are sampling-free integer operations. The
charged cache diagnostics remain outside semantic DTOs and are never used to
make search decisions.

**Cleanup contract.** On normal completion, the geometry and free-material
caches are explicitly cleared and their retained containers are shrunk before
the final diagnostics snapshot. Current charged bytes and entry counts are zero
in that snapshot. Peak bytes and cumulative admission, replacement, eviction,
evicted-byte, rejection, hit, miss, and cloning-hit counters are preserved.
Panic unwind uses normal ownership drop instead of a separate publication path.

**Comparison discipline.** Per prompt §13.7's closing sentence, one-thread and
multi-thread snapshots are compared "to verify that speedup is not consumed
by lock contention, duplicate work, or destroyed reuse". The cap and thread
matrix in §3.2 provides the cache-specific evidence. Snapshot fields are never asserted for byte-for-byte
equality against a fixed golden value (unlike canonical hashes); they are
compared as measurements with documented acceptable ranges (e.g. "hit rate
must not regress by more than a preregistered tolerance"), consistent with
prompt §13.7: "Schedule-dependent telemetry values are compared only as
measurements, never as parity fields."

---

## 7. Rayon integration

Rayon is implemented through the job-owned pool in `boundary::parallel`. The
integration follows rulings R11 and R19: deterministic pure work may run in
parallel, while cache ownership, publication, cancellation observation, and
all externally visible ordering remain serial coordinator responsibilities.

**Job-owned thread pool; no global-pool leakage across jobs.** Per prompt
§14.4 ("consider a job-owned Rayon pool... that prevents unrelated native
work from unexpectedly sharing one unconstrained global pool") and
architecture.md §4.2 ("one job-owned Rayon thread pool
(`rayon::ThreadPoolBuilder`), only from Stage 4 onward — not the global Rayon
pool"), `boundary::run_job` constructs one job-owned pool and installs it for that
job's parallel work, never using `rayon::spawn` or the ambient global pool.
The pool-isolation test constructs overlapping jobs on separate host threads
and uses worker thread-local pool tags to prove that each job's parallel work
runs only on its own pool. A sequential lifecycle test proves that dropping each
installation guard clears the coordinator thread-local pool slot, so later work
falls back to inline execution rather than retaining the prior installed pool.

**Thread-count configuration: env/option, diagnostics-only visibility.** Per
prompt §14.4 ("provide controlled thread-count configuration for tests and
deployment... do not let thread count affect algorithmic budgets or selected
output... include thread count in non-authoritative diagnostic metadata")
and prompt §7's diagnostic-channel rule: thread count is resolved once per
job, before any Rayon work starts, from (highest priority first): (1) an
explicit Rust `run_job_from_json` test and profiling override used by unit and
integration harnesses, but not exposed through N-API or persisted options; (2)
the process-level environment variable
`MIN_PLANE_IRREGULAR_NATIVE_THREADS` for controlled deployment tuning; (3) the
compiled-in safe default of `1`. Invalid or non-positive environment values
also fall back to `1`. The resolved thread
count is echoed into the diagnostic channel (`native_capability()`-style,
architecture.md §4.5) alongside backend identity, crate version, and cache
policy identity — never into the result DTO, checkpoints, or any hashed
surface. `tests/thread_equality.rs` compares timing-normalized structured JSON
envelopes across requested thread counts and repeated runs. The release cache
cap matrix separately compares timing-normalized serialized envelope bytes
across cap and thread-count combinations. Neither test claims checkpoint
serialization coverage.

**Oversubscription avoidance with Electron's worker.** The compiled-in default
is one Rayon worker. Deployments may opt into a higher count through
`MIN_PLANE_IRREGULAR_NATIVE_THREADS` after measuring whole-application load, including
the Node worker, Electron main process, renderers, and I/O activity. The cache
contract does not prescribe a core-count formula. Any promoted default above
one belongs in `performance-contract.md` with representative evidence.

**Determinism rules.**

- **Stable ordinals.** Every parallel batch this cache design's namespaces
  participate in (per-placed-piece NFP resolution, per-pair NFP-NFP
  intersection search, per-candidate-point legality assessment — all
  identified as provisional Rayon candidates in nfp-ifp.md §13) must assign
  a stable ordinal to each unit of work *before* dispatching to Rayon,
  matching prompt §14.3's deterministic pattern. This document does not
  itself enumerate every Rayon site (that is `parallelism-inventory.md`'s
  job, prompt §22 artifact #5); it fixes the constraint that any such site
  touching a namespace in this document must not let cache insertion order
  or computation-completion order become an implicit ordinal — the ordinal
  is the *input* index (e.g. `placed[i]`'s position in `input.placed`), never
  "the order threads happened to finish."
- **Serial reduction with exact TS comparators (ruling R11).** Ruling R11
  requires "serial left-to-right reduction in original loop order for every
  Number accumulation feeding ranked/serialized values; parallel term
  computation allowed, reduction serial." Applied to this cache family: the
  *pure geometry computation* behind a cache miss (e.g.
  `computeRelativeNfpBoundary`) may itself use Rayon internally only if its
  own internal floating-point accumulations (e.g. `strictConvexInteriorPoint`'s
  centroid sum, nfp-ifp.md §7) are still reduced serially in the exact
  original operand order — parallelizing the *outer* per-placed-piece loop
  does not license parallelizing (or reordering) the *inner* arithmetic of
  one placed piece's own NFP construction, which must remain bit-identical
  to the single-threaded TS-equivalent computation regardless of how many
  Rayon workers the outer batch uses.
- **Cancellation observation points preserved (ruling R19).** Per §2's
  cleanup discussion and nfp-ifp.md §10, the cooperative
  `'placed-nfp'`/`'ifp'`/`'candidate-points'` checkpoints bracket whole
  cache transactions, never interrupt one. A Rayon-parallelized version of
  the per-placed-piece NFP loop must evaluate cancellation at the same
  *logical* boundary — before dispatching the parallel batch and/or after
  collecting it, never *inside* an individual parallel task's cache
  interaction — matching ruling R19's "no new mid-computation cancellation
  points inside functions that have none." This is the same constraint §2
  already states for cleanup; it is restated here because it specifically
  governs how a Rayon batch boundary must align with the existing checkpoint
  boundary, not just how a panic/cancel unwinds.

Rayon integration is implemented and covered by the parallelism inventory and
thread-equality tests. The cache-specific rule remains narrower than general
parallel execution: workers may compute immutable geometry results, but all
cache probes, cloning resolver hits, publications, eviction, recency mutation,
and telemetry updates occur on the coordinator.

---

## 8. Implemented decisions and remaining tuning

1. `validatedRings` is not promoted into process-global concurrent Rust state.
   Correctness does not depend on reproducing the TypeScript memo's existence.
2. The geometry cache is a finite 56 MiB deterministic charged LRU. The
   free-material cache is a finite 8 MiB charged insertion-order FIFO. These
   policies are authorized by `PR27-REMEDIATION-PLAN.md` Sections 9 and 10 and
   validated by default, unlimited, tight, and zero-cap parity runs.
3. Cache telemetry uses coordinator-owned plain integers. No cache counter
   requires atomic or thread-local merging because Rayon workers do not mutate
   cache state.
4. A thread-local front cache is not implemented. The current non-cloning NFP
   probe and serial publication path preserve reuse without introducing another
   cache lifetime or synchronization policy.
5. Exact production thread-count defaults remain a deployment and performance
   tuning concern governed by `performance-contract.md`. Thread-count changes
   must not alter algorithmic budgets or semantic output.
6. Any future cache-policy change must retain deterministic admission and
   eviction, conservative retained-allocation charging, explicit cleanup, and
   exact semantic equivalence against the TypeScript oracle.
