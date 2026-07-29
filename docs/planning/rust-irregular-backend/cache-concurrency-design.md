# Cache and Concurrency Design

Status: **Stage 0 design document** (migration prompt §22 artifact #4). No
concurrent-cache code exists yet — `crates/irregular-nesting-native/src/caches/mod.rs`
is an empty stub (commit `dbcfec2`). This document is the required Stage 3
design that must exist, be instrumented, and be tested **before** Rayon is
added to `Cargo.toml` (migration prompt §6 Stage 3: "Do not enable broad Rayon
parallelism until the cache architecture is designed, instrumented, and
tested"; architecture.md §8 Stage 3: "No Rayon dependency is added to
`Cargo.toml` in this stage").

Governing spec: `docs/prompts/fable5-rust-irregular-nesting-implementation.md`
(hereafter "the prompt") §13 (cache architecture for true multithreading) and
§14 (safe/unsafe parallelization boundaries), read in full for this document.
Source of truth for every TS behavioral claim below is
`docs/planning/rust-irregular-backend/characterization/geometry-caches.md`
("geometry-caches.md") and `characterization/nfp-ifp.md` ("nfp-ifp.md"), both
read in full, plus direct reads of
`src/workers/irregular/geometryCacheStoreLive.ts`,
`src/workers/irregular/core/geometryCacheStore.ts`,
`src/workers/irregular/geometryCacheKeys.ts`, and the relevant excerpt of
`src/workers/irregular/nfpIfpService.ts` (lines 600–729) performed directly
for this document where the characterization prose needed a primary-source
check. `docs/planning/rust-irregular-backend/stage0-rulings.md` ("rulings")
and `docs/planning/rust-irregular-backend/characterization/capacity-search.md`
§9 ("capacity-search.md §9") supply the capacity-lane cache picture that sits
above this cluster. `architecture.md` §3.10/§4.2 fix the module boundary
(`caches/`) and the one-cache-per-job invariant this document must not
relax.

This document does not choose or approve promotion thresholds
(`performance-contract.md` governs that) and does not decide whether Rayon
sites are net wins (Stage 4 measurement). It designs how caches behave when
Rayon sites are eventually added, and specifies the measurement plan Stage 3
must run before Stage 4 starts.

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
called wherever TS calls it (with or without memoization). If Stage 2
benchmarking shows revalidation cost matters (large rings — p90 = 28
vertices, p99 = 107 vertices per `trusted-ring-validation-memo.md:38-41`), the
Rust port may add a **job-local**, non-shared, single-thread-only memo keyed
by a content hash (not object identity — Rust `&[Point]`/`Vec<Point>` makes
content hashing cheap and correct) as a pure performance optimization with no
cross-thread contention surface at all — but this is optional and explicitly
does not need a concurrency policy in §3, because per geometry-caches.md §15
item 3 the orchestrator has not yet ruled that Rust must reproduce this
mechanism, only its outcome. If a future ruling requires literal
reproduction, treat it as a fifth job-local, single-writer, no-sharing cache
namespace with a trivial (thread-local) concurrency policy, never a shared
concurrent structure.

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

**Rust design.**

- One `Arc<GeometryCacheStore>` (namespaces 1.1–1.3, one physical backing
  structure keyed by `(namespace, parts)` exactly as today, per
  architecture.md §3.10/§4.2's already-fixed decision) constructed at the top
  of `boundary::run_job`, dropped when the job's stack frame returns. No
  cross-job sharing, no process-global singleton, matching
  architecture.md §4.2's "job-local by default per prompt §13.6, matching the
  current TS behavior."
- One legal-candidate memo table constructed **per search invocation** (one
  per `capacity::search` cold-search call, one per decoder/reconstruction
  invocation that today constructs a fresh `IrregularNfpIfpCandidateMemoScope`)
  — not a single job-wide table. In Rust this is naturally an owned
  `HashMap<String, CachedLegalCandidateEntry>` (not `Arc`-shared, not behind a
  lock) local to the calling function's stack frame, dropped when that
  function returns, because nothing in TS ever shares one scope across two
  concurrent search branches today (§1.4). If Stage 4 ever parallelizes two
  search branches that each independently construct their own scope
  (chronology-bound today — capacity lanes run one after another per
  capacity-search.md §9, not concurrently), each branch gets its own owned
  table; there is no cross-branch sharing to design for unless a future
  ruling changes lane chronology, which prompt §14.2 forbids doing as an
  "uncontrolled cohort" race in any case.
- No cross-job cache reuse for any of the five structures. §1.5's
  `validatedRings` analogue, if ported at all, is job-local and single-writer
  per §1.5 — never a process-global structure, unlike its TS original.

**Cleanup on completion/cancellation/panic.**

- **Completion**: `Arc<GeometryCacheStore>` and all per-invocation candidate
  tables are ordinary Rust owned values; they are dropped (deallocated)
  automatically when `boundary::run_job` returns, whether by success or by
  a typed error return. No explicit `.clear()` call is needed or should be
  added — geometry-caches.md §9.5 confirms production TS **never calls**
  `GeometryCache.clear()` either (grep-confirmed zero production call sites);
  cleanup is GC-only in TS and drop-only in Rust, and both are equivalent
  "cache discarded when the job's execution scope ends" behavior. Do not add
  an explicit clear/flush call that TS does not have — it would be a new,
  unauthorized code path with no TS analogue to differentially test against.
- **Cancellation**: per architecture.md §4.3, production cancellation today
  is a whole-process/whole-thread kill (`WorkerSupervisor.cancelJob`
  disposing the `ManagedRuntime`), not an in-band cooperative signal that
  reaches this cluster's resolvers (nfp-ifp.md §10: "None exist inside this
  cluster's seven files" for the geometry-cache resolvers themselves; the
  `'placed-nfp'`/`'ifp'`/`'candidate-points'` checkpoints live one layer up in
  `nfpIfpService.ts` and observe **between**, never **during**, a cache
  transaction). A Rust job's cancellation-observation seam (ruling R19: "the
  production supervisor kill remains the outer mechanism; the native job also
  honors the cooperative `isCancelled` polling seam at the same logical
  observation points TS has") must never fire mid-cache-transaction either —
  a checkpoint check placed inside a single-flight critical section, or
  between a `remove` and its paired `set`, would be a new, TS-incompatible
  observation point (prompt §13.2's closing sentence; §7 below expands this
  for single-flight specifically). Because the whole-process-kill path
  terminates the OS thread/process, Rust cache cleanup on that path is
  "whatever the OS does when the process dies" — nothing to design, matching
  TS's own equivalent nothing-to-design status.
- **Panic**: prompt §13.1 requires "invalid or stale values are never
  published as valid hits" and prompt §13.5 requires "handle panics and
  cancellation without permanently poisoning a key." Because every cache
  structure in this design is job-local and owned (never behind a
  process-lifetime `Mutex`/`RwLock` that could be poisoned by a panicking
  holder and then observed by a *different job*), a panic inside one job's
  cache access can only poison *that job's* own `Arc<GeometryCacheStore>`,
  which is discarded when `boundary::run_job` unwinds and its panic is
  contained at the N-API boundary (architecture.md §4.4,
  `boundary::contain_panics`). No `std::sync::Mutex`/`RwLock`
  poisoning-across-jobs hazard exists by construction because no cache
  structure is shared across jobs. Within one job, if Stage 3/4 introduces
  per-key locks for single-flight (§4), those locks must not use
  `std::sync::Mutex`'s poison-on-panic default in a way that would make a
  *different key in the same job* permanently unusable after one key's
  computation panics — §4 specifies the exact non-poisoning mechanism.

---

## 3. Per-namespace concurrency policy

This section evaluates the five architectures from prompt §13.3 against each
namespace's measured access pattern (§1) and states a concrete Stage 3
recommendation per namespace, plus the measurement plan that confirms or
refutes it before Stage 4 adopts it. Per prompt §13.3's own framing ("The
likely design should use different policies for different cache namespaces...
This is a hypothesis to test, not a mandated implementation"), the
recommendations below are Stage 3 **hypotheses requiring the stated
measurement**, not decisions this Stage 0 document is authorized to finalize.
No Rayon site may be adopted (vs. removed/narrowed, prompt §19.3) until its
governing namespace's measurement in this section passes.

### 3.1 The five candidate architectures, as they apply to this cache family

1. **Sharded concurrent shared cache** (e.g. N locked/lock-free shards keyed
   by a hash of the cache key). Pro: bounded contention under concurrent
   access to *different* keys; simple mental model. Con: every access still
   pays a shard-lookup + lock cost even on the extremely common case (98%+ of
   1.1's lookups) where the *same* key is being read by many logically
   sequential call sites; sizing shard count is a tuning knob with no TS
   analogue to validate against.
2. **Shared read-mostly cache plus per-thread front caches.** Pro: a
   thread-local front cache turns a hot repeated key (e.g. two placements
   both needing the same fixed/moving NFP pair) into a lock-free hit after
   the first miss on that thread; matches prompt §13.3's own suggested
   default ("immutable high-reuse NFP data may benefit from a shared sharded
   backing store with small thread-local front caches"). Con: memory
   duplication across threads (bounded — front caches are small and evictable,
   §5); a key computed once per shard-store but replicated into every
   thread's front cache is not "wasted" work (the shared store still holds
   one canonical value) but does duplicate storage.
3. **Per-key single-flight computation with deterministic immutable
   publication.** Pro: guarantees "duplicate computation" is bounded to "at
   most one racing computation loses and its result is discarded" rather
   than "every requester recomputes"; directly satisfies prompt §13.1's "cache
   insertion race order never changes output" because only one computation
   ever gets published per key generation. Con: requires careful design to
   avoid holding a lock across expensive geometry work (§4) and to avoid
   poisoning (§4); adds a small bookkeeping cost (a per-key in-flight marker)
   even on an eventual-hit path.
4. **Phase-local precomputation followed by immutable shared lookup
   tables.** Pro: zero runtime contention once the table is built — reads are
   plain immutable lookups. Con: requires knowing the full key set for a
   phase in advance, which is **not true** for namespaces 1.1–1.3: their key
   set is discovered incrementally as placed pieces and candidate points are
   processed within one search step, not enumerable up front without
   duplicating the algorithm's own logic to precompute it. This architecture
   fits a namespace with a small, staticaly-enumerable key set far better
   than it fits NFP/IFP/transform caches; see §3.2–3.4 for where it is
   actually a good fit (none of 1.1–1.4, as discussed below) versus where a
   variant of it is already implicit (transform pre-materialization by stable
   piece/transform index, a separate parallel-batch design question covered
   in `parallelism-inventory.md`, not this cache's namespace policy).
5. **Hybrid policies by namespace.** This is the recommended top-level shape
   (§3.2–3.5): namespaces 1.1–1.3 are not interchangeable in access
   frequency, value size, or recompute cost, and the legal-candidate memo
   (1.4) has a fundamentally different lifetime (per-invocation, not
   per-job) that makes it unsuitable for the same policy as 1.1–1.3 in any
   case.

### 3.2 Namespace `pairwise-nfp-relative-v3` (§1.1) — recommendation: architecture 2 (shared sharded/locked store + small thread-local front cache), single-flight (architecture 3) as the shared-store miss path

This is the highest-reuse namespace (98.2% present rate on Mixed-61) and the
one the prompt names explicitly as the namespace a naive Rust port is most
likely to regress (prompt §6 Stage 3: "This reuse is a central performance
property... A Rust implementation that recomputes cache hits per thread can
be slower even if each geometry operation is faster"). Recommendation:

- Backing store: a sharded map (shard key = a fast hash of the legacy byte
  key, or of the interned key struct proven equivalent to it per prompt
  §13.4) with a small `RwLock` or lock-free structure per shard, holding
  `Arc<InternalPolygon>` values. Multiple concurrent readers on the same key
  proceed without blocking each other; only a genuine miss takes a write path.
- Single-flight on miss (§4): the first thread to observe a miss for key K
  becomes the sole computer for K; other threads requesting K while
  computation is in flight wait for the same `Arc` rather than each
  recomputing. This directly targets the "recompute on every 98%-hit-rate
  lookup" failure mode the prompt warns about, but for the *concurrent-miss*
  case specifically — an ordinary sequential-shard-store hit never needs
  single-flight at all; single-flight only matters when two threads observe
  a miss for the *same* key in the same narrow window (the case a 98.2%
  present rate makes rare per key, but not zero, once N threads run
  concurrently against a shared search frontier).
- Thread-local front cache: optional Stage 4 refinement, only if measurement
  (§3.6) shows shard-lock/shard-hash overhead is a material fraction of
  total NFP-resolution time even after single-flight removes duplicate
  compute. Not assumed necessary at Stage 3; added only with a measured
  justification per prompt §21's "every optimization must include: the
  identified cost... a focused test... before-and-after measurement."
- Translation (`translateNfpBoundary`) is never cached (§1.1) and stays
  entirely thread-local/per-call — it operates on the `Arc<InternalPolygon>`
  the shared store returned, producing a new owned value per call; no
  concurrency policy is needed for it beyond ordinary `Arc` sharing.

### 3.3 Namespace `transform-collision-v1` (§1.2) — recommendation: same shape as 3.2, lower priority

Same architecture (sharded/locked store + single-flight-on-miss), because the
access-sequence shape is structurally identical (§1.2's four-step
validate/lookup/stale-evict/recompute/publish sequence mirrors §1.1's) and
the measured present-rate (≈95.1%) is high enough that the same "don't
recompute on every hit" property matters, just at roughly 1/27th the raw
lookup volume of namespace 1.1 (10,028 vs. 266,977 on the Mixed-61 gate run).
No thread-local front cache is recommended even as a Stage 4 refinement
candidate unless measurement specifically shows this namespace is contended
— it is a materially smaller contributor to total lookup volume and should
not receive engineering effort ahead of evidence.

### 3.4 Namespace `sheet-ifp-v1` (§1.3) — recommendation: architecture 1 (plain sharded/locked store), no single-flight required by default, revisit if measurement shows contention

IFP bounds are cheap to (re)compute (four bounds subtractions plus
finiteness checks, `ifpBoundsCore.ts:60-99`) relative to NFP boundary
construction (a Minkowski-sum convex-hull computation). The
compute-vs-lookup cost ratio for this namespace favors "allow duplicate
computation, publish by exact-key equality, last/first writer is
semantically irrelevant" (prompt §13.5's second option) over single-flight's
extra bookkeeping — but this is a **hypothesis**, not a decision: if Stage 3
measurement (§3.6) shows this namespace's compute cost is not actually small
relative to lock/shard overhead (e.g. because it is looked up far more
frequently per job than NFP, which this document's evidence does not
establish either way — geometry-caches.md and nfp-ifp.md do not report a
separate Mixed-61 lookup count for `sheet-ifp-v1`), the recommendation
reverts to the same single-flight shape as 3.2/3.3. Duplicate computation
under this policy must still: measure duplicate count and wasted CPU, prove
duplicate results are exact (trivial here — `resolveIfpBounds` is a pure
function of its typed inputs), publish using exact-key equality, and bound
memory spikes (prompt §13.5's four duplicate-computation requirements) —
this is a real requirement of adopting this policy, not a free pass.

### 3.5 Namespace `legal-placement-candidates-v1` (§1.4) — recommendation: no shared/concurrent structure; owned, single-writer, per-invocation table (a variant of architecture 4, scoped correctly)

Because this memo's TS lifetime is per-search-invocation, not per-job
(§1.4, §2), and because nothing in TS ever shares one
`IrregularNfpIfpCandidateMemoScope` across two concurrently-running search
branches today (capacity lanes run sequentially — capacity-search.md §9), the
correct Rust concurrency policy is **no concurrency policy**: each search
invocation owns its table exclusively for the duration of that invocation, on
whichever thread runs that invocation. This is architecture 4
("phase-local... immutable shared lookup tables") in spirit — the table is
effectively phase-local — but without the "shared" or "immutable" parts,
because the table is genuinely mutated (grows) during the invocation it
belongs to, by exactly one logical owner. If a future Stage 4 design
parallelizes work *within* one search invocation (e.g. §14.1's "independent
candidate legality or score evaluation within one already ordered candidate
batch"), that parallel work must not itself read or write this per-invocation
table from multiple threads simultaneously — the memo publish happens once,
serially, after `generatePlacementCandidatesUncached` returns (§1.4 step 7),
which is already a natural serial reduction point compatible with prompt
§14.3's deterministic pattern.

### 3.6 Measurement plan (must run before any Stage 4 site touching these namespaces is adopted)

Counters (the full set is specified as a concrete struct in §6) must be
captured at **thread count 1** and at each Stage 4 candidate thread count
(prompt §18.4: 1, 2, default, one higher representative count) on the same
fixture set used for `performance-contract.md`'s comparison matrix (at
minimum: Mixed-61 `2000x2700`, plus one small and one medium representative
Compact/Compact Short Side case). For each namespace and each thread count,
record:

- **Lookups, hits, misses, stores** — the 1-thread run's values are the
  reference; prompt §6 Stage 3 requires the Mixed-61 reuse bar (266,977
  lookups / 262,166 hits / 4,811 stores / 98.2% for `pairwise-nfp-relative-v3`)
  to **survive** concurrency, meaning: the N-thread run's **hit rate**
  (hits / lookups) must not regress materially versus the 1-thread run for
  the same fixture and same algorithmic work (some lookup-count drift versus
  1-thread is expected and acceptable if the underlying search itself
  performs different total work at different thread counts — but algorithmic
  work must **not** vary by thread count per prompt §14.4 ("do not let thread
  count affect algorithmic budgets or selected output"), so in a
  correctly-designed Rust port the lookup count itself should be
  thread-count-invariant, and only the hit/miss/single-flight-wait split
  should vary with contention).
- **Duplicate computations** (a computation that ran to completion for a key
  that was already published, or already being single-flight-computed by
  another thread, by the time this computation finished) — must be
  bounded and explained; an unbounded or growing-with-thread-count duplicate
  count for namespace 1.1 specifically is a stop condition (prompt §24: "any
  cache race changes a trace or ledger" is the correctness stop condition;
  this measurement is the matching **performance** stop condition under
  prompt §19.3's "if a Rayon parallelization makes a workload slower, remove
  or narrow it").
- **Single-flight waits** (namespaces using architecture 3) — count and, if
  cheaply obtainable without disturbing the timing being measured, total wait
  time; used to confirm single-flight is actually preventing duplicate work
  rather than only adding bookkeeping overhead with no contended keys to
  protect.
- **Shard-lock wait time or contention count** — per prompt §13.7's required
  telemetry; used to detect the "one coarse mutex serializes the hottest
  path" failure mode the prompt explicitly warns against (prompt §6 Stage 3).
- **Net wall-clock effect**: for each candidate thread count, total job wall
  time attributable to NFP/IFP/transform resolution (phase timing by
  namespace, §6) must decrease or stay flat relative to the 1-thread Rust
  baseline, once duplicate-computation and lock-contention costs are
  included — not just the parallel geometry-kernel time in isolation. This is
  the concrete instantiation of prompt §19.3's "multi-thread Rust must meet
  the approved improvement over one-thread Rust on representative heavy
  cases after cache contention and overhead" for this specific subsystem.

Pass/fail is evaluated per namespace, per fixture, per thread count. A
namespace whose measurement fails (hit rate regresses, duplicate computation
grows unbounded, or net wall time regresses at some thread count) has its
Stage 4 parallel site for that namespace **narrowed or removed**, not
shipped with a caveat, per prompt §19.3's explicit instruction. This
document does not claim any measurement has been run yet — Rayon is not yet
a dependency (architecture.md §8 Stage 3) — it specifies what must be run and
what "pass" means before Stage 4 begins.

---

## 4. Single-flight design details

Applies to namespaces 1.1 and 1.2 by default recommendation (§3.2, §3.3), and
to 1.3 conditionally (§3.4) if measurement requires it. The design is
namespace-agnostic; it operates on `(key, compute_fn) -> Arc<Value>` for any
of the three `GeometryCacheStore` namespaces.

**No shard lock held during geometry computation.** The shard lock (or
equivalent synchronization primitive) is held only for the following brief,
non-computational operations: (a) checking whether the key is present, absent,
or in-flight; (b) if absent, installing an in-flight marker for this thread
and releasing the lock before starting computation; (c) after computation,
re-acquiring the lock only long enough to install the computed `Arc<Value>`
and wake waiters, or to remove the in-flight marker on failure. The actual
NFP/IFP/transform computation (`computeRelativeNfpBoundary`,
`computeIfpBounds`, `computeTransformedCollisionGeometry` — all pure
functions of their typed inputs, geometry-caches.md §4, nfp-ifp.md §13) runs
with no lock held, matching prompt §13.5's "avoid holding a shard lock while
doing expensive geometry" requirement directly.

**Panic or early return during computation does not poison a key.** If the
computing thread panics or returns an error while holding the "I am
computing this key" role, the in-flight marker must be actively cleared (not
left dangling) so a subsequent request for the same key retries computation
rather than waiting forever or observing a poisoned/unusable slot. Concretely:
wrap the in-flight-marker lifetime in a Rust guard type whose `Drop`
implementation clears the marker (and wakes any waiters with a "retry" signal
rather than a value) unless the marker was explicitly "resolved" (either
published with a value or explicitly marked as a completed failure) before
the guard drops — this is the standard "drop guard clears on unwind" pattern
and does **not** use `std::sync::Mutex`'s default poison-on-panic behavior
(which would make the *shard*, not just the key, unusable after one panic;
§2's job-scoping already bounds panic blast radius to one job, but within one
job a poisoned shard would still incorrectly affect *other keys in the same
shard*, which is not acceptable — only the specific key being computed may be
affected, and only for the duration of the retry).

**Prevent wait cycles.** Because every computation in this cache family is a
pure function of already-fully-known typed inputs (no cache namespace in this
document ever computes a value that itself requires waiting on a different
key in the *same* namespace — NFP/IFP/transform resolution do not recursively
look up other NFP/IFP/transform cache entries, confirmed by the callee lists
in geometry-caches.md §2), there is no possibility of a genuine
key-A-waits-for-key-B-waits-for-key-A cycle within one namespace. Cross-namespace
ordering (e.g. transform-collision lookups happening before the NFP lookups
that consume their output, per the TS call order in
`nfpIfpService.ts:314-329`) is a strict producer-then-consumer relationship,
never a cycle, because the consumer's key can only be constructed once the
producer's value is already in hand. No additional cycle-prevention machinery
(e.g. a wait-graph detector) is required; this is a structural property of
the pure-function cache family, not an assumption to re-verify per computation.

**Waiters receive the same immutable Arc'd value.** All namespaces publish
`Arc<Value>` (`Arc<InternalPolygon>` for 1.1, `Arc<TransformedCollisionGeometry>`-equivalent
for 1.2, `Arc<InternalIfpBounds>` for 1.3). A waiter that was blocked during
another thread's computation receives a clone of the same `Arc` the computing
thread published — never a second independently-computed value, even though
`computeRelativeNfpBoundary`/etc. are pure and would produce an
exact-equal-but-differently-allocated value if actually re-run. This is
stronger than "duplicate results are exact" (prompt §13.5's fallback
requirement for the duplicate-computation policy) — single-flight's whole
purpose is that there is never a second computation to be exact against.

**Invalid results never published.** Matches the TS access sequence exactly
(§1.1 step "recompute failure... cache is never written"; §1.2 step "compute
failure... cache is never written"; §1.3 step "two distinct failure
kinds... both without a set"): if the single computing thread's call to the
pure compute function fails, the in-flight marker resolves to "no value
published" (not an error cached as if it were a value), and the key remains
absent from the cache — the *next* request for that key will attempt
computation again from scratch, exactly as TS's "miss, recompute, fail, no
publish" sequence would on a subsequent call with the same (still-failing)
inputs. Waiters that were blocked on a computation that ultimately failed
must themselves fail with the same error (or retry-and-fail themselves,
which produces an identical typed error since the computation is
deterministic) — never silently receive a stale or default value.

**Deterministic cleanup.** Every in-flight marker, shard-lock guard, and
waiter registration is an ordinary Rust owned value scoped to the job's
`Arc<GeometryCacheStore>` lifetime (§2); there is no separate cleanup pass
required beyond ordinary `Drop` at job-scope end. Because no marker or lock is
ever held past the synchronous extent of one `get`/`compute`/`publish`
sequence (the "no lock held during computation" rule above already ensures
this), there is no possibility of a leaked in-flight marker blocking a future
job — the marker's owning `Arc<GeometryCacheStore>` is dropped when the job
ends, taking any leftover state with it (and by construction there should be
no leftover in-flight state at job end anyway, because `boundary::run_job`
does not return until all spawned work for that job — including any
in-flight single-flight computations — has completed, consistent with prompt
§7's "ensure an abandoned or cancelled JavaScript promise cannot leak a
native job or cache").

**Cache-insertion race order has no semantic effect.** Because single-flight
guarantees exactly one computation per key generation, and TS's own
`remove`-then-`set` stale-eviction sequence (§1.1–1.3) is reproduced as a
serialized sequence of shard-lock-held operations around (not across) the
uncontended computation window, no interleaving of concurrent requests for
the same key can change which value ends up published for that key — this
directly satisfies prompt §13.1's "cache insertion race order never changes
output" for the published *value*. Telemetry counts (§6) are explicitly
permitted to vary with thread count and scheduling (prompt §13.7: "compared
only as measurements, never as parity fields") and are not part of this
guarantee's scope.

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

**Peak-bytes accounting.** Per prompt §13.7's required telemetry ("approximate
and peak bytes by namespace"), track an approximate per-entry byte estimate
at publish time (point count × coordinate size for polygon-shaped values,
fixed struct size for bounds-shaped values) and maintain a running peak (not
current — "peak," per the prompt's own wording) per namespace, reset at job
start. This is diagnostic-only (§6) and must never be read by any
control-flow decision, matching the same non-semantic-channel rule that
governs every other telemetry counter in this design.

**Eviction is telemetry-driven, never behavior-driven, and off by default at
Stage 3.** Given the job-local, input-bounded nature of these caches (no
observed pathological unbounded growth in the TS baseline — geometry-caches.md
and nfp-ifp.md report no memory-cap or eviction-for-size mechanism in the
current implementation beyond stale-value replacement), Stage 3 does not
introduce a size-based eviction policy by default; the existing
`remove`-on-stale mechanism (already ported 1:1 per §1) is the only eviction
TS has, and it is correctness-driven (an invalid cached value must not be
served), not memory-driven. If a future stage adds size-based eviction (e.g.
an LRU cap per namespace) as a genuinely new capability, prompt §13.6's rules
govern it exactly: eviction order must not affect results, a missing value
may cost time but not alter behavior, and no nondeterministic telemetry
assertion may depend on race-sensitive eviction order. This document
reserves the `caches` module's eviction hook as a no-op for Stage 3 and
records size-based eviction policy as an explicit open question (§8) rather
than deciding it now, because no evidence in the characterization corpus
establishes that it is needed.

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

/// One namespace's counters. `namespace` is a stable string identifier
/// matching the TS namespace constants verbatim (e.g. "pairwise-nfp-relative-v3")
/// so evidence can be cross-referenced against the TS baseline by name.
#[derive(Debug, Default, Clone)]
pub struct CacheNamespaceTelemetry {
    /// Every `get` call, hit or miss (TS: `getCalls`).
    pub lookups: u64,
    /// Lookups that resolved to a valid, immediately-usable published value
    /// without waiting on an in-flight computation (a strict subset of TS's
    /// `getPresent`, which also counts stale hits about to be evicted; Rust
    /// separates "present" into `hits` + `stale_detections` deliberately —
    /// see field docs below — because TS's `getPresent` conflates them).
    pub hits: u64,
    /// Lookups that found no entry and no in-flight computation (must start
    /// a fresh computation).
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
    /// A computation ran to completion for a key that was already published
    /// or already being computed by another thread by the time this
    /// computation finished (architecture 3/duplicate-computation policies
    /// only; always 0 under strict single-flight with no policy bug).
    pub duplicate_computations: u64,
    /// Times a thread blocked waiting for another thread's in-flight
    /// single-flight computation of the same key (architecture 3 only).
    pub single_flight_waits: u64,
    /// Approximate cumulative time spent by all threads waiting on a shard
    /// lock for this namespace, in nanoseconds. Coarse-grained and
    /// low-overhead by construction (prompt §13.7: "low-overhead integer
    /// telemetry, disabled or sampling-free by default if necessary").
    pub shard_lock_wait_nanos: u64,
    /// Count of shard-lock acquisitions that were contended (had to wait at
    /// all), independent of the wait-time sum above.
    pub shard_lock_contended_acquisitions: u64,
    /// Front-cache hits, if a thread-local front cache is in use for this
    /// namespace (§3.2's optional Stage 4 refinement); 0 if not applicable.
    pub front_cache_hits: u64,
    /// Hits served by the shared backing store (as opposed to a front
    /// cache); equals `hits` when no front cache is in use.
    pub backing_cache_hits: u64,
    /// Entries evicted for a reason other than staleness (size-based
    /// eviction, §5); always 0 unless a future stage adds size-based
    /// eviction as an explicit new capability.
    pub evictions: u64,
    /// Current entry count for this namespace at the moment of snapshot.
    pub entries: u64,
    /// Approximate current bytes for this namespace at the moment of
    /// snapshot (§5's per-entry byte estimate, summed).
    pub approx_bytes: u64,
    /// Peak approximate bytes for this namespace observed at any point
    /// during the job (§5), never decreasing within one job's lifetime.
    pub peak_bytes: u64,
    /// Cumulative wall time spent inside this namespace's pure compute
    /// function (e.g. `computeRelativeNfpBoundary`'s Rust equivalent),
    /// across every computation (single-flight winners and, under a
    /// duplicate-computation policy, every duplicate), in nanoseconds.
    pub computation_time_nanos: u64,
}

/// One job's complete cache telemetry snapshot. Namespace keys are stable
/// strings matching the TS namespace constants; `BTreeMap` (not `HashMap`)
/// is used only so a printed/serialized snapshot has deterministic key
/// order for human review — this ordering is diagnostic convenience, not a
/// parity requirement (contrast with prompt §9's ordering rules, which
/// govern canonical/semantic output, not this sidecar).
#[derive(Debug, Default, Clone)]
pub struct CacheTelemetrySnapshot {
    pub namespaces: BTreeMap<String, CacheNamespaceTelemetry>,
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

Namespace strings populated in `namespaces`: `"pairwise-nfp-relative-v3"`,
`"transform-collision-v1"`, `"sheet-ifp-v1"` (all three matching TS's exact
namespace constants verbatim, §1.1–1.3), plus `"legal-placement-candidates-v1"`
(§1.4) for the per-invocation memo, aggregated across every invocation within
the job (summed, not one entry per invocation — matching the level of
aggregation TS's own `nfpIfpTelemetry.ts` counters operate at, which are
process/job-wide sums, not per-scope breakdowns).

**Collection cost.** Every counter is a plain integer increment (`u64`,
`AtomicU64` where cross-thread, per Stage 4) — matching TS's own documented
"single `undefined` comparison, allocates nothing" zero-overhead-when-disabled
design (`nfpIfpTelemetry.ts:9-11`, geometry-caches.md §9.6). Collection may be
compiled out entirely (a Cargo feature flag) or gated behind a boolean
job-option for release builds if measurement shows even atomic-increment
overhead is material on the hottest path (namespace 1.1 at ~267k lookups per
Mixed-61 run) — this decision is deferred to Stage 3 implementation with a
measurement, not fixed here.

**Comparison discipline.** Per prompt §13.7's closing sentence, one-thread and
multi-thread snapshots are compared "to verify that speedup is not consumed
by lock contention, duplicate work, or destroyed reuse" — this is exactly the
§3.6 measurement plan's job. Snapshot fields are never asserted for byte-for-byte
equality against a fixed golden value (unlike canonical hashes); they are
compared as measurements with documented acceptable ranges (e.g. "hit rate
must not regress by more than a preregistered tolerance"), consistent with
prompt §13.7: "Schedule-dependent telemetry values are compared only as
measurements, never as parity fields."

---

## 7. Rayon integration

Not yet implemented (Rayon is not a Stage 3 dependency, architecture.md §8).
This section specifies the constraints the eventual Stage 4 integration must
satisfy, grounded in this cache design and in rulings R11/R19.

**Job-owned thread pool; no global-pool leakage across jobs.** Per prompt
§14.4 ("consider a job-owned Rayon pool... that prevents unrelated native
work from unexpectedly sharing one unconstrained global pool") and
architecture.md §4.2 ("one job-owned Rayon thread pool
(`rayon::ThreadPoolBuilder`), only from Stage 4 onward — not the global Rayon
pool"), `boundary::run_job` constructs one `rayon::ThreadPool` at job start
(Stage 4 only) and uses it exclusively for that job's parallel work via
`pool.install(...)`/`pool.scope(...)`, never `rayon::spawn`/the ambient
global pool. This must be proved, not assumed: a Stage 4 test constructs two
(or more) jobs whose execution windows overlap in the test process (e.g. two
`boundary::run_job` calls on separate host threads, or two calls where the
second starts before the first's pool is dropped) and asserts, by a
counting/tagging mechanism internal to the test (e.g. each pool tags its
worker threads with the owning job's ID via `rayon::ThreadPoolBuilder::thread_name`
or a thread-local set at pool-thread-start), that no Rayon worker thread ever
executes work tagged with a different job's ID. A second test constructs and
tears down N jobs sequentially and asserts the OS thread count returns to
baseline after each job's pool is dropped (no leaked pool threads,
matching prompt §14.4's "prove clean shutdown and no pool leak across
repeated jobs").

**Thread-count configuration: env/option, diagnostics-only visibility.** Per
prompt §14.4 ("provide controlled thread-count configuration for tests and
deployment... do not let thread count affect algorithmic budgets or selected
output... include thread count in non-authoritative diagnostic metadata")
and prompt §7's diagnostic-channel rule: thread count is resolved once per
job, before any Rayon work starts, from (highest priority first): (1) an
explicit per-call test/harness override passed through the N-API request
(never through the persisted `NestingOptions`/sub-run-settings path, matching
§6's backend-selector precedent in architecture.md §6 — thread count is
exactly the same class of non-persisted, out-of-band configuration as backend
selection); (2) a process-level environment variable (e.g.
`IRREGULAR_NATIVE_THREADS`) for controlled deployment tuning; (3) a
compiled-in default (`rayon::current_num_threads()`'s ordinary
core-count-based default, or `1` if Stage 4 has not yet been promoted for a
given site — see §7's oversubscription note below for why `1` may remain the
shipped default even after Stage 4 lands for some sites). The resolved thread
count is echoed into the diagnostic channel (`native_capability()`-style,
architecture.md §4.5) alongside backend identity, crate version, and cache
policy identity — never into the result DTO, checkpoints, or any hashed
surface. A test asserts that two otherwise-identical jobs differing only in
requested thread count produce byte-identical result DTOs, canonical hashes,
and checkpoint bytes (under the injected deterministic clock seam, §3.11 of
architecture.md) — this is the concrete form of prompt §14.4's "no thread
count setting may change exact output" and prompt §18.4's determinism-test
requirement.

**Oversubscription avoidance with Electron's worker.** The irregular worker
already runs inside one Node `worker_thread` (`nesting.worker.ts`); that
worker thread is itself one OS thread competing for CPU with whatever Rayon
pool a Rust job constructs. A job-owned Rayon pool sized to
`num_cpus - 1` (reserving one core for the Node worker thread and Electron's
main/IO threads) is the default policy candidate; the exact formula is a
Stage 4 implementation decision informed by measurement on the reference
machine (`performance-contract.md` §1's machine), not fixed by this document,
but the *constraint* — a job-owned pool must not be sized to assume the whole
machine is idle, because Electron's main process, renderer processes, and the
worker thread itself are concurrently live — is fixed here as a hard
requirement. This must be measured, not assumed: the §3.6 measurement plan's
"net wall-clock effect" check must be run with the rest of the application
(or a realistic stand-in load) active, not only in an isolated benchmark
process, before a default thread count above 1 is adopted for production.

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

No Rayon dependency, pool construction, or parallel site is claimed as
implemented by this document. §7 specifies the contract Stage 4 must satisfy
when it lands; `parallelism-inventory.md` is the artifact that enumerates and
tracks each individual site against these rules.

---

## 8. Open questions

1. **`validatedRings` literal-reproduction requirement (§1.5) needs an
   explicit orchestrator ruling**, not just this document's recommendation.
   geometry-caches.md §15 item 3 already flags this as unresolved; this
   document's position (job-local optional memo, or no memo at all, never a
   shared/concurrent structure) is a recommendation for *if* a memo is
   ported, but whether Rust must reproduce the memo's *existence* at all
   (versus only its outcome) is not yet ruled. Stage 2 (single-thread parity)
   can proceed without this ruling since the outcome is provably identical
   either way; Stage 3's concurrency policy for it (§1.5) only matters once
   the ruling lands, but should be settled before Stage 3 sign-off so it is
   not revisited mid-implementation.
2. **Namespace `sheet-ifp-v1`'s actual Mixed-61 lookup volume is not
   established by the characterization corpus.** §3.4's duplicate-vs-single-flight
   recommendation is a hypothesis specifically because
   `trusted-ring-validation-memo.md:30-34` reports figures only for
   `pairwise-nfp-relative-v3` and `transform-collision-v1`, not
   `sheet-ifp-v1`. Before Stage 3 finalizes this namespace's policy, capture
   its lookup/hit/store counts on the same Mixed-61 gate run (the existing
   `--capture-cache-telemetry` flag on `scripts/irregular-sheet-invariance.ts`
   already reports per-namespace TS telemetry, geometry-caches.md §9.6 — this
   is a data-capture task, not new TS code).
3. **Thread-local front-cache adoption for namespace `pairwise-nfp-relative-v3`
   (§3.2) is explicitly deferred pending measurement**, not decided. If §3.6's
   measurement shows shard-lock overhead is negligible relative to geometry
   computation time even at the highest tested thread count, the front cache
   should not be added at all (prompt §21: "every optimization must include
   the identified cost" — an unmeasured-as-necessary optimization should not
   ship). This document intentionally leaves the decision open rather than
   pre-committing engineering effort.
4. **Exact job-owned Rayon pool sizing formula relative to Electron's worker
   thread and main/renderer processes (§7)** is not fixed by this document
   and requires machine-specific measurement against a realistic concurrent
   load, not an isolated benchmark. `performance-contract.md` should record
   the final formula once measured; this document only fixes the constraint
   that oversubscription must be measured under realistic load before a
   thread count above 1 becomes any kind of default.
5. **Whether `duplicate_computations`/`single_flight_waits` should be
   `AtomicU64` (cross-thread-visible in real time) or per-thread-local
   counters merged only at job end** is an implementation detail not decided
   by §6's struct definition. Atomics have a small but real cost on the
   hottest path (namespace 1.1); thread-local-merge-at-end has zero
   cross-thread cost but cannot be inspected mid-job (irrelevant for this
   design, since telemetry is only read after job completion via the
   diagnostic channel, §4.5 of architecture.md). Recommendation: thread-local
   accumulation merged serially at job end, deferred to Stage 4
   implementation for final confirmation once the actual Rayon task
   boundaries are known.
6. **Size-based eviction (§5) is explicitly out of Stage 3 scope** because no
   evidence in the characterization corpus shows current TS caches need one
   (no memory-cap or size-eviction mechanism exists in the TS baseline for
   any of the four namespaces). If a future pathological-input case (e.g. an
   extremely high piece count with high shape diversity) is found in
   practice to need bounded memory, that is a new capability requiring its
   own explicit ruling under prompt §13.6's rules, not something this
   document authorizes preemptively.
