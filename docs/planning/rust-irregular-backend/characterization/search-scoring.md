# Characterization: search-scoring cluster

Stage 0 characterization for the Rust irregular-nesting port. Governing spec:
`docs/history/prompts/fable5-rust-irregular-nesting-implementation.md` (hereafter "the
migration prompt"). This document is exhaustive and normative for the five
files below; a Rust implementer should be able to port from it without
re-reading the TypeScript, and a parity reviewer should be able to verify
against it. All line numbers were read directly from the files at the commit
checked out at investigation time (`main`, see `git log -1`); re-verify before
relying on them if the files have since changed.

Files in this cluster (read in full):

- `src/workers/algorithm/irregular/irregularBeamState.ts` (986 lines)
- `src/workers/algorithm/irregular/irregularPlacementScorer.ts` (451 lines)
- `src/workers/algorithm/irregular/irregularLayoutScorer.ts` (585 lines)
- `src/workers/algorithm/irregular/irregularScoreGrid.ts` (42 lines)
- `src/workers/algorithm/sortPiecesForNesting.ts` (18 lines)

**Headline finding, stated up front because it inverts the naive reading of
these files:** the elaborate score *comparators* in
`irregularPlacementScorer.ts` (`compareScores`, `balancedCompactnessOrder`,
`shortSideFillOrder`, `edgeContactThenBalancedCompactnessOrder`,
`intrinsicCompactnessOrder`) and in `irregularLayoutScorer.ts`
(`layoutScoreOrder`, `strictLayoutScoreOrder`, `scaleAwareLayoutScoreOrder`)
are **not used to select anything** on the production Compact / Compact Short
Side path under default settings. They are exercised only by the legacy
`portfolioSearch.ts` / `windowedBeam.ts` beam search, which is unreachable
when `intrinsicSharedArchiveEnabled: true` (the production default — see
§1). What *is* live in production is: (a) `IrregularBeamState`'s canonical
occupied-geometry key machinery (used pervasively for state dedup in the
complete/capacity search), (b) `irregularPlacementScorer.ts`'s pure
`scoreCandidate` *value computation* (not its comparators), called once per
retained candidate inside capacity search to obtain
`sharedCollisionBoundaryLengthMm`, and (c) `irregularLayoutScorer.ts`'s
`scoreState` *value computation*, called exactly once per completed job to
build the externally-visible `IrregularLayoutScoreSummary`. See §1 for the
full liveness matrix and the Grep evidence behind each claim.

---

## 1. Purpose and role in Compact / Compact Short Side execution

### 1.1 Production entry and eligibility gate

Both profiles execute through `computeIrregularNesting()`
(`src/workers/algorithm/irregular/computeIrregularNesting.ts:364-451`), which
sorts pieces, prepares collision geometry, then delegates to
`coordinateIntrinsicSharedArchive()` (line 474), whose own doc-comment says:
*"Runs the intrinsic archive as the compact production path"*
(computeIrregularNesting.ts:473).

Whether that "intrinsic shared archive" path or the legacy classic
beam-search path (`portfolioSearch.ts` / `windowedBeam.ts`) runs is decided
by `isIntrinsicSharedArchiveEligible(input.settings)`
(computeIrregularNesting.ts:483, defined at line 1695) which delegates to
`intrinsicSharedArchiveEligibility()`
(`src/shared/irregular/executionMode.ts:16-35`):

```
eligible === true  iff  optimizer.intrinsicSharedArchiveEnabled === true
                    AND  optimizer.placementPolicyId !== 'short-side-fill'
                    AND  (gaEnabled === false OR baselineOnly === true OR
                          gaTimeBudgetMs === 0 OR gaGenerationBudget === 0 OR
                          gaEvaluationBudget === 0)
```

Production defaults (`src/shared/irregular/defaults.ts`):
- Compact: `DEFAULT_IRREGULAR_OPTIMIZER_SETTINGS =
  makeCompactQualityIrregularOptimizerSettings()` (defaults.ts:177-178) sets
  `intrinsicSharedArchiveEnabled: true`, `baselineOnly: true`,
  `gaEnabled: false`, `placementPolicyId:
  'edge-contact-then-balanced-compactness'` (defaults.ts:148-165).
- Compact Short Side: `makeCompactShortSideIrregularOptimizerSettings()`
  (defaults.ts:168-175) is the Compact-quality settings plus
  `intrinsicObjectiveProfileId: 'short-side'`.

Both satisfy the eligibility predicate, so **`archiveEnabled` is `true` for
both production profiles under default settings**
(computeIrregularNesting.ts:483, 1065 `else` branch only reachable when
`archiveEnabled` is `false`).

### 1.2 Per-module liveness on the production path

| Symbol | File | Live on production Compact/Short-Side path? | Evidence |
|---|---|---|---|
| `IrregularBeamState` class, `.withPlacement`, `.withUnplacedPiece`, `.withBottomLeftAnchored`, `.withQuarterTurnBottomLeft`, `canonicalOccupiedGeometryKey`, `bottomLeftAnchoredCanonicalOccupiedGeometryKey()` | irregularBeamState.ts | **Yes, heavily.** | Used directly by production modules: `intrinsicStrictDecoder.ts` (its local `scoreCandidate` at line 1394 calls `state.withPlacement` at line 1420 and `bottomLeftAnchoredCanonicalOccupiedGeometryKey()` at line 1443; dedup checks at lines 559, 1097, 1176, 1204), `intrinsicCapacitySearch.ts` (lines 507, 654-684, 697-729, 720, 1150, 1480-1481, 1525-1526, 1605), `intrinsicCapacityEndpoint.ts:96`, `intrinsicSharedArchivePortfolio.ts` (imports `IrregularBeamState` at line 38), `intrinsicShortSideObserver.ts`, `intrinsicShortSidePairFoldObserver.ts`, and `computeIrregularNesting.ts` itself (lines 894-908, 1102-1110, 1262-1267, 1489-1496, 1530-1536, 1598-1605). |
| `canonicalCollisionPolygonKey`, `canonicalRingKey`, `canonicalPointKey`, `canonicalNumber`, `canonicalToken`, `canonicalRecord`, `compareCanonicalKeys`, `insertCanonicalEntryKey`, `canonicalEntryListKey`, `normalizeCanonicalCoordinate` | irregularBeamState.ts | **Yes**, as the private machinery behind `canonicalOccupiedGeometryKey`/`bottomLeftAnchoredCanonicalOccupiedGeometryKey()`. The exported top-level `canonicalCollisionPolygonKey` function itself (line 744) is imported externally only by `intrinsicExactProjection.ts:31`, which is **not** reachable from `computeIrregularNesting.ts` (see §1.3) — so the exported entry point is dead for production, but the identical logic is live via the class methods that call `canonicalPlacedGeometryKey` → `canonicalCollisionPolygonKey` internally (lines 714-732). | Grep of `canonicalOccupiedGeometryKey` usage (§8) across `intrinsicStrictDecoder.ts`, `intrinsicCapacitySearch.ts`, `intrinsicCapacityEndpoint.ts`, `intrinsicPlaceDeferCompleteShadow.ts`. |
| `IrregularPlacementScorer.Service.scoreCandidate` (pure value computation) | irregularPlacementScorer.ts:198-281 | **Yes, but only via the hardcoded `.Make` instance**, not the DI-configured `.Live`/`.Layer` instance. | `intrinsicCapacitySearch.ts:654` calls `IrregularPlacementScorer.Make.scoreCandidate({...})` directly (bypassing Effect context) inside the `captureTopologyRetention` branch, which is `true` in production because the default capacity retention mode is `'cohesion-frontier'` (computeIrregularNesting.ts:538, intrinsicCapacitySearch.ts:339-342). Only the `sharedCollisionBoundaryLengthMm` field of the returned score is read (intrinsicCapacitySearch.ts:673-680). |
| `IrregularPlacementScorer.Service.compare` and all its `Order` chains (`balancedCompactnessOrder`, `shortSideFillOrder`, `edgeContactThenBalancedCompactnessOrder`, `intrinsicCompactnessOrder`, `intrinsicEnvelopeOrder`, `deterministicLocalTieBreakOrder`) | irregularPlacementScorer.ts:103-158, 283-313 | **No.** | The only callers of `.compare`/`compareBalancedCompactnessPlacementScores`/`compareIntrinsicCompactnessPlacementScores` are `windowedBeam.ts` (lines 1472, 1666, 1703) and the DI-provided `IrregularPlacementScorer` service consumed by `IrregularNestingPortfolioLive` (portfolioSearch.ts:177), which only runs `.run()` in the `else` branch of `archiveEnabled` (computeIrregularNesting.ts:1065-1069) — unreachable under production defaults. `intrinsicCapacitySearch.ts`'s own selection comparator is the module-local `compareScoredCandidateReferences` (intrinsicCapacitySearch.ts:1731), which is a different function entirely. |
| `IrregularPlacementScorer.Live`/`.Layer` (DI-configured instance reading `settings.optimizer.placementPolicyId`) | irregularPlacementScorer.ts:177-196 | **Constructed but its `scoreCandidate`/`compare` are not exercised** in the archive-eligible branch. It is still resolved as an Effect service every run because `IrregularNestingPortfolioLive` unconditionally requires it (portfolioSearch.ts:177) and `computeIrregularNesting.ts` unconditionally builds `portfolioService` via that layer (computeIrregularNesting.ts:434-438) even though `.run()` is never invoked for archive-eligible requests. | nesting.worker.ts:395 `Effect.provide(IrregularPlacementScorer.Layer)`. |
| `IrregularLayoutScorer.Service.scoreState` (pure value computation, incl. free-material cache) | irregularLayoutScorer.ts:129-148 | **Yes, exactly once per completed job.** | Called from exactly one of four mutually-exclusive `materialize*` functions in computeIrregularNesting.ts, each executed at most once per run: `materializeIntrinsicCapacityResult` (line 1270), `materializeProductionResult` (line 1499, legacy non-archive branch only), `materializeSharedArchiveResult` (line 1539), `materializeIntrinsicShortSideProfileResult` (line 1608). Its output becomes `IrregularPortfolioResult.score`, part of the externally observable result. |
| `IrregularLayoutScorer.Service.compare` and `layoutScoreOrder`/`strictLayoutScoreOrder`/`scaleAwareLayoutScoreOrder`/`collisionBoundsMaxSideMm` | irregularLayoutScorer.ts:506-576 | **No.** | Only caller of `.compare`/`layoutScoreOrder` anywhere in `src/` outside the defining file is `windowedBeam.ts` (lines 921, 1079, 1099, 2110, 2648) — dead for production per §1.1. `computeIrregularNesting.ts` calls `.scoreState` four times (above) but never `.compare`. |
| `deriveRawOccupiedHullWasteRatio`, `deriveFreeMaterialMetrics`, `polygonArea`, `polygonPerimeter`, `convexHull`, `makeFreeMaterialCacheKey`, `computeSnapshotWithParentFallback` | irregularLayoutScorer.ts | **Yes**, all reached from `scoreDerivedState` (line 224) which is reached by the one live `scoreState` call per job. | Same call chain as above. |
| `canonicalizeIrregularScoreMillimeters`, `canonicalizeIrregularScoreMillimeterUnits`, `canonicalizeIrregularScoreScalar` | irregularScoreGrid.ts | **Yes**, from three call sites: `irregularBeamState.ts:854` (`normalizeCanonicalCoordinate`, used by every canonical key built during production search — see §1.2 row 1), `irregularPlacementScorer.ts:213-223` (only live via the `.Make` capacity-search path), `irregularLayoutScorer.ts:238-241, 265-270, 278-279` (live via the once-per-job `scoreState` call). | Direct imports; see file headers. |
| `sortPiecesForNesting` | sortPiecesForNesting.ts | **Yes.** | `computeIrregularNesting.ts:380` calls it unconditionally as the very first step, before the archive-eligibility branch; its output (`sortedPieces`) becomes the prepared-piece build order for both profiles. Also used by the *rectangular* algorithm at `src/workers/algorithm/computeNesting.ts:66` — this file is a shared boundary between rectangular and irregular nesting (see §1.3). |

### 1.3 Dead-for-production sibling modules referenced above

To avoid confusion when reading call graphs, the following files are
imported by files in this cluster or reference this cluster, but are
themselves **not reachable** from `computeIrregularNesting.ts` under
production defaults (no import edge from `computeIrregularNesting.ts`,
`portfolioSearch.ts`'s live subtree, `intrinsicSharedArchivePortfolio.ts`,
`intrinsicStrictDecoder.ts`, `intrinsicCapacityMode.ts`, or
`intrinsicCapacitySearch.ts`):

- `windowedBeam.ts` — imported only by `portfolioSearch.ts:?` (the classic
  beam engine) and `targetedExactLns.ts`.
- `strictPriorityDecoder.ts`, `intrinsicDetachedPieceReinsertion.ts`,
  `intrinsicGlobalSqueezePortfolio.ts`, `intrinsicQueueBeamDiscriminator.ts`
  — no importers found anywhere under `src/` (Grep of
  `from '\./<name>\.js'` across `src/`), i.e. orphaned except from their own
  test files and each other's experimental family (`intrinsicV7SeedArchive.ts`,
  `intrinsicSqueezeDisruptSeparate.ts`, `intrinsicTransformSeparator.ts`,
  `intrinsicExactProjection.ts`, `overlapRelaxation.ts`,
  `overlapRelaxationV1.ts`, `intrinsicTwoPieceInterfaceReconstruction.ts`).
- `targetedExactLns.ts`, `overlapRelaxation.ts` — reachable only from the
  orphaned experimental family above.

**This dead-for-production status is a fact about the *default* production
settings, not an immutable property of the schema.** `intrinsicSharedArchiveEnabled`,
`placementPolicyId`, `gaEnabled`, `baselineOnly`, `gaTimeBudgetMs`,
`gaGenerationBudget`, `gaEvaluationBudget` are all ordinary schema-decoded
optimizer settings fields (`src/shared/irregular/domain.ts:319-424`), so a
non-default but schema-legal settings object could still route execution
through the classic beam search and exercise every comparator in
`irregularPlacementScorer.ts` and `irregularLayoutScorer.ts`. See §15 for the
open question this creates for Rust port scope.

---

## 2. Entry points, callers, callees (traced)

### 2.1 `sortPiecesForNesting.ts`

- **Signature:** `sortPiecesForNesting(pieces: ReadonlyArray<PreparedPiece>):
  ReadonlyArray<PreparedPiece>` (sortPiecesForNesting.ts:14-18).
- **Callers:**
  - `src/workers/algorithm/irregular/computeIrregularNesting.ts:380` — irregular path, both Compact and Compact Short Side, first step of `computeIrregularNesting()`.
  - `src/workers/algorithm/computeNesting.ts:66` — rectangular path (out of this cluster's scope per the migration prompt §4.2, but shares the exact same function/behavior; a Rust port that special-cases irregular-only would silently create a rectangular/irregular ordering divergence if this function is ever touched — see §15).
- **Callees:** `Order` from `effect` only (`Order.combineAll`, `Order.mapInput`, `Order.flip`, `Order.Number`) and `Array.prototype.toSorted`. No geometry, no I/O, no Effect context requirement (pure, synchronous, total function — return type is not wrapped in `Effect`).
- **Governance note:** `AGENTS.md:46` — *"`src/workers/algorithm/sortPiecesForNesting.ts` is the user-owned initial ordering boundary. Do not change its behavior unless the user explicitly asks for algorithm work."* Also documented at `docs/architecture/algorithm-boundary.md:15` — *"`sortPiecesForNesting` is the user-owned initial ordering boundary. It may contain user-provided ordering logic, but it must not place pieces, score placements, split free rectangles, or produce history."* This is a repository-level hard rule independent of the migration prompt's general semantics-preservation mandate; treat it as doubly non-negotiable.

### 2.2 `irregularBeamState.ts`

- **Primary export:** `class IrregularBeamState` with static `empty()`
  (line 139) and instance methods `continuationMetadataIdentity()` (149),
  `canonicalEntryContinuationIdentity()` (158),
  `contactSignatureContinuationIdentity()` (162), `withPlacement()` (172),
  `withUnplacedPiece()` (255), `withBottomLeftAnchored()` (287),
  `bottomLeftAnchoredCanonicalOccupiedGeometryKey()` (357),
  `withQuarterTurnBottomLeft()` (379). Also exports the free function
  `canonicalCollisionPolygonKey()` (744).
- **Constructed directly (`new IrregularBeamState({...})`, bypassing
  incremental `withPlacement`) by:** `computeIrregularNesting.ts` (lines
  894-908 short-side observer winner reconstruction, 1102-1110 short-side
  observer winner rotation, 1262-1267 capacity result, 1489-1496 legacy
  production result, 1530-1536 shared-archive result, 1598-1605 short-side
  profile result), `intrinsicCapacitySearch.ts` (line ~507, empty state
  construction for capacity search root), `intrinsicShortSideObserver.ts`,
  `intrinsicShortSidePairFoldObserver.ts`. Each such construction triggers a
  **fresh** `deriveMetadata()` call (line 119) rather than reusing
  incrementally-extended metadata — see §4.3 for why this matters bit-for-bit.
- **Constructed incrementally (`.withPlacement`/`.withUnplacedPiece`/
  `.withBottomLeftAnchored`/`.withQuarterTurnBottomLeft`) by:**
  `intrinsicStrictDecoder.ts` (local `scoreCandidate`, line 1420 calls
  `input.state.withPlacement`), `intrinsicCapacitySearch.ts` (line ~697,
  candidate materialization inside `buildReference`).
- **Callees:** `makePlacedCollisionSpatialIndex`,
  `PlacedCollisionSpatialEntry`, `PlacedCollisionSpatialIndex` from
  `src/workers/irregular/placedCollisionSpatialIndex.ts:26-54`;
  `measureSharedConvexPolygonBoundaryContact` from
  `src/workers/irregular/convexPolygonContact.ts:67`;
  `canonicalizeIrregularScoreMillimeterUnits` from `irregularScoreGrid.ts:21`.
  Also `performance.now` from `node:perf_hooks` (line 2) for optional phase
  timing (diagnostic only, not semantic — see §10).

### 2.3 `irregularPlacementScorer.ts`

- **Primary export:** `class IrregularPlacementScorer` (an `effect`
  `Context.Service`) with static `.Make` (a fixed, DI-independent instance
  hardcoded to `BALANCED_COMPACTNESS_POLICY_ID`, line 170-175), `.Layer` (DI
  layer reading `GeometrySettings`, line 177-194), `.Live` (`.Layer` merged
  with `GeometrySettings.Live`, line 196). Also exports
  `compareBalancedCompactnessPlacementScores` (300),
  `compareIntrinsicCompactnessPlacementScores` (308), the error class
  `IrregularPlacementScoringError` (28-33), and policy-id string constants
  (18, 21, 24-25).
- **Live caller (production):** `intrinsicCapacitySearch.ts:654` via
  `IrregularPlacementScorer.Make.scoreCandidate(...)`.
- **Dead-for-production callers:** `windowedBeam.ts` (imports the Order
  functions and the Service type), `strictPriorityDecoder.ts`,
  `intrinsicDetachedPieceReinsertion.ts`, `targetedExactLns.ts` (type-only
  import), `portfolioSearch.ts:24` (imports the Service to build
  `IrregularNestingPortfolioLive`, itself unreachable in production — see
  §1.3), `computeIrregularNesting.ts:36-39` (imports only the type and error
  class for the Effect environment signature, never calls `.scoreCandidate`
  or `.compare` on it directly).
- **Callees:** `translatePolygonWithBounds` from
  `src/workers/irregular/convexBounds.ts:34`,
  `sharedConvexPolygonBoundaryLength` from
  `src/workers/irregular/convexPolygonContact.ts:28`,
  `canonicalizeIrregularScoreMillimeters` from `irregularScoreGrid.ts:15`,
  `GeometrySettings` from `src/workers/irregular/geometryKernel.ts` (DI
  context, `.Layer` path only).

### 2.4 `irregularLayoutScorer.ts`

- **Primary export:** `class IrregularLayoutScorer` (`Context.Service`) with
  `.Make` (an `Effect.gen` builder, not a plain instance — line 123-148),
  `.Layer` (150), `.Live` (`.Layer` merged with `FreeMaterialServiceLive`,
  151-153). Also exports `IrregularLayoutScoringError` (22-25),
  `deriveRawOccupiedHullWasteRatio` (412), `STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT`
  (511, value `20`), `STRUCTURAL_CONTACT_COUNT_BAND_WIDTH` (513, value `2`).
- **Live caller (production):** `computeIrregularNesting.ts` — `layoutScorer
  = yield* IrregularLayoutScorer` (line 387), then `.scoreState(...)` at
  lines 1270, 1499, 1539, 1608 (exactly one of these executes per completed
  job — see §1.2). `nesting.worker.ts:396` provides `IrregularLayoutScorer.Live`.
- **Dead-for-production caller:** `windowedBeam.ts` (`.compare` and
  `.scoreState` both, at the line numbers in §1.2), `portfolioSearch.ts:25`
  (type import for `IrregularNestingPortfolioLive`'s dependency list, itself
  unreachable in production).
- **Callees:** `FreeMaterialService` (`.computeFreeMaterial`,
  `.extendFreeMaterial`) from `src/workers/irregular/services.ts:333,340`,
  concretely `FreeMaterialServiceLive` from
  `src/workers/irregular/freeMaterialService.ts`; `GeometryPredicates.orientation`
  from `src/workers/irregular/geometryPredicates.ts:16` (used inside the
  local `convexHull` helper, line 479, 493); `canonicalizeIrregularScoreMillimeters`
  and `canonicalizeIrregularScoreScalar` from `irregularScoreGrid.ts`.

### 2.5 `irregularScoreGrid.ts`

- **Pure leaf module.** No imports beyond nothing (no `import` statements at
  all — self-contained). Exports three functions and two constants
  (`IRREGULAR_SCORE_GRID_STEP_MM = 0.001`,
  `IRREGULAR_SCORE_SCALAR_STEP = 0.000001`).
- **Callers:** `irregularBeamState.ts:854`, `irregularPlacementScorer.ts:15,
  213-223`, `irregularLayoutScorer.ts:17-19, 238-241, 265-270, 278-279`.
  `windowedBeam.ts` also imports it (dead for production).

---

## 3. Data in/out: exact types/shapes, optional-field presence/omission semantics

### 3.1 `sortPiecesForNesting`

- **In:** `ReadonlyArray<PreparedPiece>` where `PreparedPiece.paddedBounds:
  RectWith` (`src/shared/domain/nesting.ts:126`). `RectWith`
  (`src/shared/domain/geometry.ts:36-49`) extends `Rect` with
  `longestEdge: PositiveIntegerMillimeters`, `area: IntegerMillimeters`
  (constrained `> 0`), `imbalance: NonNegativeIntegerMillimeters` — **all
  three sort keys are exact integers** (`Schema.Int`), not floats. This
  removes float-tie/epsilon concerns from this comparator entirely (see §7).
- **Out:** same array, `Array.prototype.toSorted` (stable), new array
  identity, same element identities, reordered.
- **No optional fields involved.**

### 3.2 `irregularBeamState.ts`

`IrregularBeamStateInput` (lines 30-38, the constructor's logical input
before the private `[derivedMetadata]` symbol key):

| Field | Type | Omission semantics |
|---|---|---|
| `remainingPreparedPieces` | `ReadonlyArray<IrregularPreparedPiece>` | required |
| `placedCollisionGeometries` | `ReadonlyArray<IrregularPlacedPiece>` | required |
| `unplacedPieceIds` | `ReadonlyArray<PieceId>` optional | if omitted, falls back to `unplacedSourcePieceIds` (line 114) |
| `unplacedSourcePieceIds` | `ReadonlyArray<PieceId>` optional | legacy alias; if both `unplacedPieceIds` and `unplacedSourcePieceIds` are omitted, defaults to `[]` (line 114: `input.unplacedPieceIds ?? input.unplacedSourcePieceIds ?? []`). The constructor then populates **both** `this.unplacedPieceIds` and `this.unplacedSourcePieceIds` with the *same* resolved array (lines 115-116) — they are never independently distinct after construction, despite being declared as two separate readonly fields. A Rust port must decide whether to keep two fields (for call-site fidelity with existing TS call sites that pass one or the other) or collapse to one — collapsing is safe for behavior but changes the struct shape other cluster documents may reference by name (`unplacedSourcePieceIds` is read by `irregularLayoutScorer.ts:98, 308, 324` and used as a tie-break array in the dead-for-production `layoutScoreOrder`). |
| `placementOrder` | `ReadonlyArray<PieceId>` | required |
| `parent` | `IrregularBeamState \| undefined` optional | omitted ⇒ `undefined`, meaning "no incremental ancestor," which gates the free-material cache's parent-extension fast path in `irregularLayoutScorer.ts` (see §9) and the pruning behavior in `windowedBeam.ts` (dead for production). Every `new IrregularBeamState({...})` call site in `computeIrregularNesting.ts` that materializes a *final* result (§1.2 row for `.scoreState`) omits `parent`, so those states are always parent-less. |
| `placedCollisionIndex` | `PlacedCollisionSpatialIndex` optional | omitted ⇒ derived fresh (or taken from `metadata.placedCollisionIndex`) at line 120, then revalidated via `.matches(...)` at line 122 before reuse — an even-if-supplied value is not blindly trusted. |

Derived (readonly, computed, never part of external input):
`canonicalOccupiedGeometryKey: string` (always present, non-optional — see
§3.2 "sticky undefined" caveat below, which applies to the numeric derived
fields, not this string, since `canonicalEntryListKey` always succeeds for
any finite entry-key array including the empty array).
`translatedCollisionBounds: IrregularCollisionBounds | undefined`,
`sharedCollisionBoundaryLengthMm: number | undefined`,
`sharedCollisionBoundaryContactUnits: number | undefined`,
`nearCompleteStructuralContactCount: number | undefined`,
`dominantNearCompleteStructuralContactCount: number | undefined` — **these
five become `undefined` together** (they are all derived from one
`SharedCollisionBoundaryMetrics | undefined` value, or independently for
bounds) whenever any non-finite/unsafe-integer condition is hit during
derivation, and once `undefined` they are **sticky**: incremental
`.withPlacement` calls on a state with `undefined` bounds/metrics propagate
`undefined` forever down that state's descendant chain (see §4.3), because
`extendCollisionBounds` short-circuits at `if (current === undefined) return
undefined` (line 911) and `extendSharedCollisionBoundaryMetrics`
short-circuits similarly (lines 594-602). A **fresh** `new
IrregularBeamState({...})` construction from a flat
`placedCollisionGeometries` array (no `[derivedMetadata]`) always
re-derives from scratch via `deriveMetadata()` (line 119, 519-539) and does
not inherit stickiness from any prior chain.

`IrregularCollisionBounds` (lines 21-28): `minX, minY, maxX, maxY, width,
height: number`, all always finite together or the whole value is
`undefined` (never partially finite).

`SharedCollisionBoundaryMetrics` (lines 52-58): `lengthMm: number`,
`normalizedUnits: number`, `nearCompleteStructuralContactCount: number`,
`dominantNearCompleteStructuralContactCount: number`,
`nearCompleteStructuralContactSignatureCounts: ReadonlyMap<string, number>`
— the `Map` here is a **private** field on the class
(`nearCompleteStructuralContactSignatureCounts`, line 107-109), not exposed
publicly except through `contactSignatureContinuationIdentity()` (line
162-170) which serializes it via `JSON.stringify` after sorting entries by
`localeCompare` on the signature string (line 166-168) — see §5 and §12 for
why `localeCompare` here is a hazard distinct from ordinary `<`/`>` string
comparison used elsewhere in this cluster.

`canonicalCollisionPolygonKey(points, translateX = 0, translateY = 0):
string` (line 744-752) — pure function, default parameters `0`. Returns
`EMPTY_RING_KEY` (a module-level constant, line 754) when `points.length ===
0` or (defensively) when a point is `undefined` mid-loop (line 779, a
"should never happen" guard commented as *"a gap leaves no ring to
canonicalize, exactly as an absent rotation did"*).

### 3.3 `irregularPlacementScorer.ts`

`ScoreIrregularPlacementCandidateInput` (lines 42-53): `sheet: SheetSpec`,
`placed: ReadonlyArray<IrregularPlacedPiece>`, `moving:
TransformedCollisionGeometry`, `candidate: IrregularPlacementCandidate`,
`policyId?: IrregularPlacementPolicyId` optional — omission resolved at line
248: `input.policyId ?? DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID` (i.e.
`'balanced-compactness'`, from `src/shared/irregular/domain.ts:61-62`), then
**overridden unconditionally to `BALANCED_COMPACTNESS_POLICY_ID` when
`input.sheet.width === input.sheet.height`** (line 249-250, square-sheet
special case — matters for Compact Short Side's "on square sheets physical Y
is short axis" rule referenced in the migration prompt §12, though that rule
lives in a different cluster's files).

`IrregularPlacementScore` (lines 56-81): all numeric fields required
(no optionals) — `policyId`, `usedClusterMaxSideMm`,
`worstNormalizedSheetConsumption`, `normalizedSheetSpanSum`,
`usedClusterAreaMm2`, `usedClusterSpanMm`, `shortSideFill`, `longSideFill`,
`sharedCollisionBoundaryLengthMm`, `candidateBottomMm`, `candidateLeftMm`,
plus `candidate: IrregularPlacementCandidate` retained by reference for
downstream tie-breaking (used only by the dead-for-production comparators).
`scoreCandidate` (line 198) either fully succeeds with every field finite
(validated at lines 252-265) or fails with a typed
`IrregularPlacementScoringError` — there is no partial/optional-field
failure mode.

### 3.4 `irregularLayoutScorer.ts`

`ScoreIrregularLayoutInput` (lines 27-30): `sheet: SheetSpec`, `state:
IrregularBeamState` — both required.

`IrregularLayoutScore` (lines 58-99): every field required, no optionals.
Of these, the following are **never serialized into the externally-visible
`IrregularLayoutScoreSummary`** (`src/shared/irregular/domain.ts:901-...`):
`occupiedHullWasteRatio`, `collisionBoundsBottomMm`, `collisionBoundsLeftMm`,
`freeMaterialSnapshot`, `placementOrder`, `unplacedSourcePieceIds` — compare
`layoutScoreSummaryFields()` (computeIrregularNesting.ts:1709-1727) which
lists exactly the complementary set of fields. `occupiedHullWasteRatio` and
the four contact-band fields *are* used inside the dead-for-production
`layoutScoreOrder`; `collisionBoundsBottomMm`/`collisionBoundsLeftMm` are
**not used by any live consumer at all** in this cluster — their only
readers are `windowedBeam.ts:2265-2266,2292-2293,2762-2763` (dead) and
`decisionTrace.ts:170-171,189-190,209-210` (a different cluster's trace
record type whose producer needs separate verification — flagged in §15).
`freeMaterialSnapshot: FreeMaterialSnapshot` — Clipper2-derived geometry
snapshot, itself schema-backed
(`src/shared/irregular/domain.ts:867-878`, `regions: ReadonlyArray<{
boundary: IrregularPolygon, holes: ReadonlyArray<IrregularPolygon> }>`).

`IrregularLayoutScoreSummary` schema
(`src/shared/irregular/domain.ts:901-...`) — **this is the externally
observable, persisted/serialized shape**, and several of its fields are
`Schema.optional(...)`: `sharedCollisionBoundaryLengthMm`,
`sharedCollisionBoundaryContactUnits`, `sharedCollisionBoundaryContactBand`,
`nearCompleteStructuralContactCount`,
`dominantNearCompleteStructuralContactCount`,
`canonicalEnclosedCavityCount` (lines 906-919). Comment: *"Optional for
backward-compatible decoding of results saved before contact scoring"* /
*"...before scale-normalized contact scoring"* / *"...before structural-contact
classification"*. In current code, `layoutScoreSummaryFields()`
(computeIrregularNesting.ts:1709-1727) **always populates all of these**
from a fully-computed `IrregularLayoutScore` — the only field that is ever
actually *omitted* by current production code is
`canonicalEnclosedCavityCount`, conditionally spread in at
`layoutScoreSummary()` (computeIrregularNesting.ts:1699-1707): `...
(canonicalEnclosedCavityCount === undefined ? {} : {
canonicalEnclosedCavityCount })`. **A Rust port must reproduce this exact
present/omitted distinction** (not merely encode `null`/`0`), because the
schema optionality exists specifically for decoding *older persisted*
results — the field-presence bit is part of the persisted-history contract
(migration prompt §9: "optional omission preserved").

### 3.5 `irregularScoreGrid.ts`

Pure `number -> number | undefined` functions. `undefined` return means "not
finite" or "would overflow `Number.isSafeInteger` after ×1000/×1,000,000
scaling" — see §7 for the exact rule. No object shapes.

---

## 4. Algorithm state and every mutation point

`IrregularBeamState` is **immutable** — there is no in-place mutation of an
existing instance anywhere in this cluster. "State transitions" are always
"construct a new instance from an old one." All arrays copied into the
constructor are defensively spread (`[...input.remainingPreparedPieces]` etc,
lines 112-117) and `canonicalEntryKeys` is `Object.freeze`d at every
construction site that builds it fresh (lines 317, 437, 522) or extends it
(`insertCanonicalEntryKey` also returns `Object.freeze`d, line 887).

### 4.1 `withPlacement` (lines 172-253) — the hot-path transition

Called once per committed placement decision. Steps, in exact order (each
gated by `input.onPhaseTimings !== undefined` for optional diagnostic-only
timing, §10):

1. `placedCollisionGeometries = [...this.placedCollisionGeometries,
   input.placedCollisionGeometry]` — append (line 181-184).
2. `canonicalEntryKeys = insertCanonicalEntryKey(this.canonicalEntryKeys,
   canonicalPlacedGeometryKey(input.placedCollisionGeometry))` — **sorted
   insertion**, not append-then-sort (line 186-189; see §5 for the exact
   insertion algorithm, which is O(n) linear scan, not binary search).
3. `placedCollisionIndex = this.placedCollisionIndex.add(input.placedCollisionGeometry)`
   (line 193) — spatial index grows by one entry; `addedEntry =
   placedCollisionIndex.entries[length - 1]` (line 194) is the new entry
   read back from the **new** index (post-add).
4. `sharedBoundaryMetrics = extendSharedCollisionBoundaryMetrics(current,
   this.placedCollisionIndex /* OLD index, pre-add */, addedEntry)` (lines
   198-208) — see §4.3, this uses the spatial-index *query* (bbox-pruned),
   not a full scan.
5. `IrregularBeamState.fromDerivedMetadata(...)` (line 212-237) constructs
   the new state, threading through: new `remainingPreparedPieces` (caller
   supplied), appended `placedCollisionGeometries`, **unchanged**
   `unplacedPieceIds` (line 216, carried from `this`, not touched by a
   placement), appended `placementOrder` (`[...this.placementOrder,
   input.placementOrderPieceId]`, line 217), `parent: this` (line 218 — the
   new state's parent pointer is always the exact `this` object by
   reference, which is what makes the free-material cache's parent-lookup
   in `irregularLayoutScorer.ts` work, §9), and freshly-derived
   `translatedCollisionBounds` (first placement: `derivePlacedCollisionBounds`;
   subsequent: `extendCollisionBounds`, lines 223-226).

### 4.2 `withUnplacedPiece` (lines 255-281)

Simpler transition: appends to `unplacedPieceIds` (line 263), **carries all
other derived fields through unchanged by reference** (bounds, shared
boundary metrics, spatial index — lines 268-278 all read `this.*` verbatim,
no recomputation). `remainingPreparedPieces` is caller-supplied (the piece
being marked unplaced is removed from it by the caller before this call, not
by this method). `parent: this` (line 265).

### 4.3 `withBottomLeftAnchored` (lines 287-351) — full geometric rewrite

Not a small delta: translates **every** placed piece's transform by
`(-bounds.minX, -bounds.minY)` (lines 291-315), rebuilding fresh
`IrregularPlacedPiece`/`IrregularPlacement` objects with the translated
`translateX`/`translateY` (preserving `pieceId`/`placementReference` via
conditional spread only if present on the source, lines 302-305 — an
optional-field-preservation pattern repeated at lines 412-415). Returns
`this` unchanged (line 289, reference equality — no new object) when bounds
are `undefined` or already anchored at `(0,0)`. Returns `undefined` (line
297) if any translated coordinate becomes non-finite (`Number.isFinite`
check). Rebuilds `canonicalEntryKeys` **from scratch**, sorted
(`.toSorted(compareCanonicalKeys)`, line 318) — not incrementally — and
rebuilds the spatial index from scratch (`makePlacedCollisionSpatialIndex`,
line 320). **Shared boundary metrics (`sharedCollisionBoundaryLengthMm`
etc.) are carried through unchanged by reference** (lines 341-347) — this is
correct because translation is boundary-length-invariant, and it is also
the reason the "sticky undefined" property survives a bottom-left anchor: if
the pre-anchor state already had `undefined` shared-boundary metrics, the
anchored state keeps `undefined` too (never recomputed here).

### 4.4 `bottomLeftAnchoredCanonicalOccupiedGeometryKey()` (lines 357-376)

A **read-only projection** that computes what `withBottomLeftAnchored()`'s
`canonicalOccupiedGeometryKey` *would* be, without materializing the
translated placements or rebuilding the spatial index — used as a fast
dedup probe (the docstring at lines 353-356 explicitly calls out that this
exists to avoid the allocation cost of `withBottomLeftAnchored` when only
the key is needed). Returns `undefined` under the same non-finite condition
as the full method (line 369). **This function and `withBottomLeftAnchored`
must produce byte-identical key strings for the same logical translation** —
this is an unstated but load-bearing invariant (both call
`canonicalPlacedGeometryKeyAtTranslation`/`canonicalPlacedGeometryKey`
against the same translated coordinates, then both sort with
`compareCanonicalKeys` and join with `canonicalEntryListKey`). A Rust port
must keep both paths textually identical or add a differential test proving
equivalence, because production code (`intrinsicCapacitySearch.ts:720`,
`intrinsicStrictDecoder.ts:1443`) uses the fast projection as the
authoritative dedup key while other code paths may reconstruct the full
state.

### 4.5 `withQuarterTurnBottomLeft(rotationDeg)` (lines 379-465)

Rotates every placed piece's translation and polygon points by 0/90/180/270°
about the origin (`rotateQuarterTurnPoint`, lines 475-489), recomputes each
rotated piece's `IrregularBounds` via `boundsForPoints` (line 397, 500-517;
returns `undefined` if any piece has zero points, propagating `undefined`
through the whole call at line 398), builds a fresh
`IrregularTransformCandidate` with `rotationDeg` summed and normalized mod
360 into `[0, 360)` via `normalizeRotationDegrees` (line 402-404, 491-494:
`remainder = deg % 360; remainder < 0 ? remainder + 360 : remainder` — note
JS `%` can return negative for negative operands, hence the explicit
correction), rebuilds `canonicalEntryKeys` from scratch sorted (line 437-439,
same pattern as §4.3), rebuilds the spatial index from scratch (line 440),
**carries shared-boundary metrics through unchanged by reference** (lines
454-460, rotation-invariant same as translation), then **always finishes by
calling `.withBottomLeftAnchored()` on the rotated result** (line 464) —
i.e. this method's `translatedCollisionBounds` at line 453
(`deriveCollisionBounds(placedCollisionGeometries)`, freshly derived, NOT
sticky-preserved) is transient and gets replaced again by the anchoring
step's own fresh derivation. `rotationDeg === 0` short-circuits to
`this.withBottomLeftAnchored()` directly (line 382), skipping the rotation
rebuild entirely (an important special case: 0° rotation does **not**
rebuild `canonicalEntryKeys`/spatial index from scratch, only the
anchoring step does — a Rust port that "simplifies" by always rotating
even for 0° would still be numerically correct but would diverge from the
`this`-reference-equality-on-no-op behavior of `withBottomLeftAnchored`
(§4.3) when the state is already anchored, since it would force
`canonicalEntryKeys` array reconstruction even when nothing changes; this
has no *value* effect but changes allocation/identity behavior a
performance-sensitive Rust port might otherwise assume is safe to skip).

### 4.6 Constructor-level spatial index reuse guard (lines 119-124)

```
const metadata = input[derivedMetadata] ?? deriveMetadata(this.placedCollisionGeometries)
const placedCollisionIndex = input.placedCollisionIndex ?? metadata.placedCollisionIndex
this.placedCollisionIndex =
  placedCollisionIndex !== undefined && placedCollisionIndex.matches(this.placedCollisionGeometries)
    ? placedCollisionIndex
    : makePlacedCollisionSpatialIndex(this.placedCollisionGeometries)
```

Even when a caller supplies `input.placedCollisionIndex`, it is only trusted
if `.matches(...)` (`placedCollisionSpatialIndex.ts:106-116`, exact
length-and-per-element-reference equality) confirms it actually corresponds
to the *exact* `placedCollisionGeometries` array just built. This defends
against a caller passing a stale/mismatched index; a Rust port must
replicate the reference-equality check exactly (in Rust terms: `Arc::ptr_eq`
or an equivalent identity check per element, not a value/structural
equality check — this file's `.matches()` in TS is `entry.placed !==
placedPiece`, i.e. reference inequality, not deep equality).

### 4.7 Free function state (module-level `const`s, effectively immutable "state")

`EMPTY_RING_KEY` (line 754) is computed once at module load
(`canonicalRecord([['point-count', '0']])`) and reused by reference — pure
memoization, no mutation.

---

## 5. Ordering sources

### 5.1 Every `sort`/`toSorted` in this cluster

| Location | What is sorted | Comparator | Stable? |
|---|---|---|---|
| `sortPiecesForNesting.ts:17` | `pieces` (all prepared pieces for the job) | `order` = `Order.mapInput(paddedBoundsOrder, piece => piece.paddedBounds)`, itself `Order.combineAll([flip(longestEdge), flip(area), flip(imbalance)])` (lines 6-12) — descending by longestEdge, then area, then imbalance | `Array.prototype.toSorted` is spec-guaranteed stable (ECMA-262 stable sort since ES2019) — **equal-key pieces retain their original relative order**, which is the array order `request.pieces` arrives in from the caller (i.e., an implicit fourth tie-break the TS code never states explicitly: original request order). A Rust port must sort with a stable algorithm (e.g. `slice::sort_by`, not `sort_unstable_by`) or explicitly carry an original-index tie-break. |
| `irregularBeamState.ts:318, 438, 523` | `placedCollisionGeometries.map(canonicalPlacedGeometryKey)` | `compareCanonicalKeys` (867-871, plain `<`/`>` on strings) via `.toSorted(compareCanonicalKeys)` | Stable, but **irrelevant here** because the sort key (the canonical key string) is a bijective function of exactly one placed piece, and canonical keys across distinct placements should never collide unless two pieces occupy literally identical canonical geometry — in that theoretical tie case, stability preserves array-encounter order among the tied pieces. |
| `irregularBeamState.ts:462` (`convexHull`'s internal `[...points].sort(compareInternalPoints)`, actually in `irregularLayoutScorer.ts:462`, not beam state — see next row) | — | — | — |
| `irregularLayoutScorer.ts:462` | Occupied points for the convex hull (`deriveRawOccupiedHullWasteRatio`) | `compareInternalPoints` (502-504): `first.x - second.x \|\| first.y - second.y` — **numeric subtraction as comparator return value**, not `Order.Number`. See §7 for why this differs semantically from the `Order.Number`-based comparators elsewhere (subtraction-based comparators misbehave for `NaN` operands and for values whose difference over/underflows, though `Number.isFinite` guards upstream make overflow implausible for real mm coordinates). |

### 5.2 Insertion order that is observable

`insertCanonicalEntryKey` (irregularBeamState.ts:873-888) performs a
**linear scan insertion sort** on `canonicalEntryKeys`: scans from index 0,
finds the first existing key that sorts *after* the new key
(`compareCanonicalKeys(entryKey, existingEntryKey) < 0`), splices the new
key in there (or appends at the end if none found). This keeps
`canonicalEntryKeys` sorted ascending by `compareCanonicalKeys` at all
times, incrementally, in `O(n)` per insertion (`O(n²)` cumulative per beam
branch) — **functionally equivalent to but algorithmically different from**
the from-scratch `.toSorted(compareCanonicalKeys)` calls elsewhere (§4.3,
§4.5). For duplicate keys (`compareCanonicalKeys` returns `0`), the linear
scan's `< 0` condition means the new key is inserted **after** all existing
equal keys (first index where `entryKey < existingEntryKey`, not `<=`) —
i.e. **stable relative to prior insertion order among tied keys**, and this
matches what `.toSorted` would also produce for the same logical sequence of
insertions **only if** `.toSorted` is fed the keys in the same insertion
order — which it is not in general (the from-scratch paths sort the whole
`placedCollisionGeometries` array's derived keys in placement order, which
is the same order the incremental path would have inserted them in one at a
time). This should produce identical final sorted arrays either way given a
stable sort and identical insertion order, but it means **the incremental
path and the from-scratch path only reliably converge to the same array
when the underlying `placedCollisionGeometries` sequence is identical** —
which is exactly the situation in production (fresh reconstructions always
rebuild `placedCollisionGeometries` in placement order first). Flag this as
an equivalence a Rust port should prove with a differential test rather than
merely asserting from reading the code (§15).

### 5.3 `Map`/`Set` iteration order reliance

- `nearCompleteStructuralContactSignatureCounts: Map<string, number>`
  (irregularBeamState.ts, built at lines 548, 612, 646). **Never iterated in
  insertion order for output** — the only place its contents leave the
  class is `contactSignatureContinuationIdentity()` (162-170), which
  explicitly re-sorts entries via `.toSorted(([first], [second]) =>
  first.localeCompare(second))` before `JSON.stringify`. This is a safe
  pattern (explicit sort before serialization) but note it uses
  **`localeCompare`**, not the plain `<`/`>` used by `compareCanonicalKeys`
  elsewhere — see §12, this is a real, distinct hazard: `localeCompare`'s
  result depends on the JS engine's ICU locale data and default locale,
  whereas `compareCanonicalKeys` is locale-independent UTF-16 code-unit
  order. A Rust port must use two *different* string-ordering strategies for
  these two call sites to match: one plain byte/codepoint order
  (`compareCanonicalKeys`, and `Order.String`/`canonicalNumber`'s indirect
  consumers) and one **locale-sensitive** order (`localeCompare`, used only
  here for `nearCompleteStructuralContactSignatureCounts`). Also note this
  value is **only read through `continuationMetadataIdentity()`
  /`contactSignatureContinuationIdentity()`**, and Grep shows no production
  caller of `continuationMetadataIdentity()` in this cluster's live callers
  (§1) — worth confirming with the checkpoint-cluster characterization
  whether it is read there (open question, §15).
- `deriveSharedCollisionBoundaryMetrics`'s internal
  `nearCompleteStructuralContactSignatureCounts` (line 548) and
  `sharedBoundaryWithEntries`'s (line 646) are plain accumulator `Map`s,
  never iterated for ordering (only `.get`/`.set`, and `dominantSignatureCount`
  (708-712) iterates `.values()` only to take a `Math.max`, which is
  order-independent).
- `PlacedCollisionSpatialIndex`'s internal `buckets: Map<string,
  ReadonlyArray<...>>` (`placedCollisionSpatialIndex.ts:61,80,92-93`) is
  used purely for `.get(key)` lookup by cell key; its only ordered output is
  `continuationIdentity()` (118-127) which explicitly sorts
  `[...this.buckets.entries()]` by `localeCompare` on the cell-key string
  (line 124) — same locale-sensitivity hazard as above, in a sibling file
  (out of this cluster's direct scope but directly consumed by
  `IrregularBeamState.continuationMetadataIdentity()`, line 154).
  `query()`'s (129-156) final return value is `this.entries.filter(...)` —
  filtering the **stable, ordinal-ordered `entries` array**, never iterating
  the `Map` or the internal `Set` (`selected`, line 130) for output order —
  so `query()`'s result order is deterministic and JS-Map-independent
  despite using a `Map`/`Set` internally. This matters directly for
  `sharedBoundaryWithEntries` (irregularBeamState.ts:638-682), whose
  summation order over `existingEntries` is exactly `query()`'s filtered
  order.
- `irregularLayoutScorer.ts`'s `freeMaterialCache: Map<string,
  FreeMaterialSnapshot>` (line 126) **does** rely on `Map` insertion order
  for FIFO eviction: `freeMaterialCache.keys().next().value` (line 194)
  reads the **oldest still-present key** by relying on the ECMA-262
  guarantee that `Map` iterates in insertion order. See §9 and §12 — this is
  a genuine hazard requiring an explicit FIFO structure in Rust (e.g. an
  `IndexMap` or a `VecDeque<String>` alongside a `HashMap`), not a plain
  `HashMap`.

### 5.4 Iteration orders that reach output/keys/traces

- `canonicalRingKey`'s ring-direction decision (irregularBeamState.ts:
  787-807): finds the lexicographically-smallest-by-`(y,x)` start vertex
  (lines 787-797, linear scan, first strict improvement wins — i.e. **first**
  occurrence among ties, since the condition is strict `<`), then compares
  forward vs. reverse walks starting at that vertex, offset by offset, until
  the first differing per-vertex key decides the winding direction (lines
  800-807) — if **all** offsets tie (a fully symmetric ring, e.g. under some
  point-reflection), `forwardWins` stays `true` (its initial value, line
  800), i.e. **forward wins ties**. This entire algorithm is the ring-origin
  and winding normalization the migration prompt §9 calls out by name
  ("preserve ring-origin normalization," "preserve winding normalization")
  — it is the single most important algorithm in this cluster to port
  byte-exact, because it feeds every canonical key used for state dedup
  throughout the live production search (§1.2).
- `deriveSharedCollisionBoundaryMetrics`'s outer loop order
  (`for (const entry of index.entries)`, line 549) is the spatial index's
  stable ordinal (insertion) order — i.e. `placedCollisionGeometries` array
  order, i.e. ultimately **placement order**, which is itself downstream of
  `sortPiecesForNesting`'s prepared-piece order and the search's own
  placement decisions. This exact nested iteration order determines
  floating-point summation order for `sharedCollisionBoundaryLengthMm` — see
  §7 for why this must be bit-exact.

---

## 6. Comparators and tie rules: exact comparison chains, signs, tie-breakers

All comparators in this cluster are built from `effect`'s `Order` module
(`node_modules/.pnpm/effect@4.0.0-beta.89/.../src/Order.ts`, read in full).
Key primitives, exact semantics (not paraphrased — read from source):

- `Order.make(compare)` (Order.ts:111-115): wraps `compare` with a
  **reference/value-equality short-circuit first**: `(self, that) => self
  === that ? 0 : compare(self, that)`. For primitive numbers this means `+0
  === -0` short-circuits to `0` *before* the inner NaN-aware logic ever
  runs, and for two identical `NaN` values `self === that` is `false` (NaN
  never `===` itself), so the inner logic *does* run for NaN.
- `Order.Number` (Order.ts:177-182): `if (isNaN(self) && isNaN(that)) return
  0; if (isNaN(self)) return -1; if (isNaN(that)) return 1; return self <
  that ? -1 : 1`. **All NaNs are mutually equal and sort before every
  non-NaN number; `+0` and `-0` are equal** (via the `make` short-circuit).
- `Order.String` (Order.ts:144): `self < that ? -1 : 1` (wrapped in `make`,
  so equal strings short-circuit to `0` first) — plain JS `<` on strings,
  i.e. **UTF-16 code-unit lexicographic order**, not locale-aware, not
  Unicode-codepoint order for values outside the BMP (surrogate pairs
  compare code-unit-by-code-unit, which can differ from codepoint order for
  astral characters — irrelevant here since all strings compared are
  synthetic ASCII canonical-key tokens, but worth stating precisely per the
  migration prompt §12's explicit call-out of UTF-16 comparison).
- `Order.Boolean` (209): `false < true`.
- `Order.flip(O)` (269-271): swaps arguments, itself re-wrapped in `make`
  (redundant but harmless double equality check).
- `Order.combine`/`Order.combineAll` (315-409, 483-494): **short-circuits on
  first non-zero**, iterates the provided array/collection in its literal
  order — i.e. exactly a lexicographic tuple comparison in source-declared
  order.
- `Order.mapInput(O, f)` (528-598): `(b1, b2) => O(f(b1), f(b2))`, wrapped in
  `make` so `b1 === b2` (object reference equality on the *unmapped* input)
  short-circuits to `0` first — essentially never true for distinct score
  objects.
- `Order.Array(O)` (679-692, exported as `Array`): elementwise via `O`,
  first non-zero wins; if all compared elements tie, **shorter array sorts
  first** (`Number(aLen, bLen)`, i.e. `Order.Number` on lengths).

### 6.1 `irregularPlacementScorer.ts` comparator chains

All defined as `Order.combineAll([...])` over `IrregularPlacementScore`.
Every field mapped via `Order.mapInput(Order.Number | Order.String |
Order.Boolean, selector)`.

**`intrinsicEnvelopeOrder`** (103-107) — ascending:
1. `usedClusterMaxSideMm`
2. `usedClusterAreaMm2`
3. `usedClusterSpanMm`

**`deterministicLocalTieBreakOrder`** (109-115) — ascending:
1. `candidate.transform.index`
2. `candidate.transform.rotationDeg`
3. `candidate.transform.mirrored` (`false < true`)
4. `candidate.transform.reason` (string, code-unit order)
5. `candidate.pieceId` (string, code-unit order)

**`balancedCompactnessOrder`** (117-120) = `intrinsicEnvelopeOrder` then
`deterministicLocalTieBreakOrder` (8-term chain total). This is the
`compareScores` fallback for any `policyId` other than `short-side-fill` or
`edge-contact-then-balanced-compactness` (line 296), and is what
`compareBalancedCompactnessPlacementScores` exports directly (300-305).

**`edgeContactThenBalancedCompactnessOrder`** (122-126):
1. `-sharedCollisionBoundaryLengthMm` (negated ⇒ **larger shared boundary
   wins**, i.e. descending on this one field only, expressed via
   arithmetic negation rather than `Order.flip`)
2. then `intrinsicEnvelopeOrder` (3 terms)
3. then `deterministicLocalTieBreakOrder` (5 terms)

Selected by `compareScores` (283-297) only when
`first.policyId === EDGE_CONTACT_THEN_BALANCED_COMPACTNESS_POLICY_ID &&
first.policyId === second.policyId` (line 290-293) — **note the
asymmetric guard**: it checks `first.policyId` against the constant twice
(once directly, once via equality with `second.policyId`), so if
`first.policyId` is the edge-contact policy but `second.policyId` differs,
this branch is skipped and execution falls through to the
`shortSideFillOrder` check (line 287, same asymmetric pattern testing
`first.policyId` against `SHORT_SIDE_FILL_POLICY_ID`), and finally to
`balancedCompactnessOrder` unconditionally (line 296) if neither matched.
**This means `compareScores` is not guaranteed symmetric/commutative when
`first.policyId !== second.policyId`** — compared with arguments swapped it
could theoretically dispatch to a different policy's order function (a
correctness note, not merely a style note: `compare(a,b)` and
`-compare(b,a)` are not obviously guaranteed equal here in the mixed-policy
case). In production, every score compared within one search always shares
the same `policyId` per job (only one `settings.optimizer.placementPolicyId`
per request), so this asymmetry is currently unobservable, but a Rust port
implementing a literal `Ordering` trait (which Rust's type system generally
expects to be well-behaved/antisymmetric) should be aware of it — flagged
in §15.

**`intrinsicCompactnessOrder`** (133-142) — ascending, 8 terms, sheet-size
independent by design (docstring: *"Sheet-independent compactness order for
protected candidate diversity"*):
1. `usedClusterMaxSideMm`
2. `usedClusterAreaMm2`
3. `usedClusterSpanMm`
4. `candidate.transform.index`
5. `candidate.transform.rotationDeg`
6. `candidate.transform.mirrored`
7. `candidate.transform.reason`
8. `candidate.pieceId`

(Same as `intrinsicEnvelopeOrder` + `deterministicLocalTieBreakOrder`
inlined rather than composed — functionally identical to
`balancedCompactnessOrder` but a textually separate declaration; exported
as `compareIntrinsicCompactnessPlacementScores`, 308-313.)

**`shortSideFillOrder`** (144-158) — ascending, 12 terms:
1. `worstNormalizedSheetConsumption`
2. `normalizedSheetSpanSum`
3. `-shortSideFill` (descending — **larger short-side fill wins**)
4. `longSideFill` (ascending — **smaller long-side fill wins**)
5. `usedClusterAreaMm2`
6. `usedClusterSpanMm`
7. `candidateBottomMm`
8. `candidateLeftMm`
9. `candidate.transform.index`
10. `candidate.transform.rotationDeg`
11. `candidate.transform.mirrored`
12. `candidate.transform.reason`
13. `candidate.pieceId`

(13 terms, not 12 — corrected count.) Selected only when
`first.policyId === SHORT_SIDE_FILL_POLICY_ID && first.policyId ===
second.policyId` (line 287). **Note:** `short-side-fill` as a
`placementPolicyId` is itself disjoint from `Compact Short Side` the
*profile* — `intrinsicSharedArchiveEligibility` explicitly treats
`placementPolicyId === 'short-side-fill'` as **ineligible** for the
production archive path (executionMode.ts:22-24), so `shortSideFillOrder`
can only ever be reached via the classic beam search (dead for production
Compact/Compact Short Side under default settings — do not confuse this
comparator's name with the Compact Short Side profile's own directional
construction, which lives entirely in other files
(`intrinsicShortSideAxes.ts` etc., outside this cluster) and does not use
this comparator at all.

**`compareScores`** dispatch order (283-297): `short-side-fill` branch
first, then `edge-contact-then-balanced-compactness` branch, then
`balancedCompactnessOrder` as the unconditional default — this is the
production `.compare` method (`IrregularPlacementScorer.Make.compare` /
`.Live.compare`), but as established in §1, **never actually invoked** on
the production Compact/Compact Short Side path.

### 6.2 `irregularLayoutScorer.ts` comparator chains

**`strictLayoutScoreOrder`** (515-528) — ascending, 12 terms (used when
`placementOrder.length <= STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT` (20) or
the two states being compared have different `placementOrder.length`):
1. `unplacedCount` (ascending — fewer unplaced wins, dominant criterion per
   the migration prompt's "Fewer unplaced prepared ids always dominate every
   later criterion" comment at line 59)
2. `-dominantNearCompleteStructuralContactCount` (descending)
3. `-nearCompleteStructuralContactCount` (descending)
4. `collisionBoundsMaxSideMm(score)` — **derived**, not a stored field; see
   §7 for its quadratic-formula computation
5. `collisionBoundsAreaMm2`
6. `collisionBoundsSpanMm`
7. `occupiedHullWasteRatio`
8. `-sharedCollisionBoundaryContactBand` (descending)
9. `-sharedCollisionBoundaryContactUnits` (descending)
10. `-sharedCollisionBoundaryLengthMm` (descending)
11. `Order.Array(Order.String)` on `placementOrder` (ascending, elementwise
    then by-length)
12. `Order.Array(Order.String)` on `unplacedSourcePieceIds` (ascending)

**`scaleAwareLayoutScoreOrder`** (530-545) — ascending, 12 terms (used when
both states have `placementOrder.length > STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT`
(20) **and** equal `placementOrder.length`, decided by `layoutScoreOrder`'s
own dispatcher, line 547-555):
1. `unplacedCount`
2. `collisionBoundsMaxSideMm(score)`
3. `collisionBoundsAreaMm2`
4. `collisionBoundsSpanMm`
5. `occupiedHullWasteRatio`
6. `-dominantNearCompleteStructuralContactCount` (descending)
7. `-Math.floor(nearCompleteStructuralContactCount /
   STRUCTURAL_CONTACT_COUNT_BAND_WIDTH)` (descending; `STRUCTURAL_CONTACT_COUNT_BAND_WIDTH
   = 2`, line 513 — **banded** structural contact count, coarser than the
   strict order's exact count)
8. `-nearCompleteStructuralContactCount` (descending, exact, as a final
   tie-break within a band)
9. `-sharedCollisionBoundaryContactUnits` (descending)
10. `-sharedCollisionBoundaryLengthMm` (descending)
11. `Order.Array(Order.String)` on `placementOrder`
12. `Order.Array(Order.String)` on `unplacedSourcePieceIds`

Note `scaleAwareLayoutScoreOrder` **omits** `sharedCollisionBoundaryContactBand`
entirely (present in strict order, absent here) and reorders `dominant...`
before `collisionBoundsMaxSideMm`... actually re-check: reading the literal
array again (lines 530-545), the order is `unplacedCount`,
`collisionBoundsMaxSideMm`, `collisionBoundsAreaMm2`, `collisionBoundsSpanMm`,
`occupiedHullWasteRatio`, **then** the contact criteria — i.e. compactness
criteria are promoted *before* structural-contact criteria in the
scale-aware order, whereas the strict order puts structural-contact criteria
**before** compactness (`dominant...`, `nearComplete...` at positions 2-3,
before `collisionBoundsMaxSideMm` at position 4). **This swap is the whole
point of the two-order split** (per the migration prompt's glossary and this
file's own doc-comments at lines 510-513: *"Small partial layouts keep exact
contact ordering while repeated motifs form"* / *"Larger layouts compare
total structural contacts in adjacent-pair bands"*) — a Rust port must not
"simplify" these into one parameterized order; the **term order itself**
changes between the two variants, not just which fields are banded.

**`layoutScoreOrder`** dispatcher (547-555):
```
samePlacementDepth = first.placementOrder.length === second.placementOrder.length
useScaleAware = samePlacementDepth && first.placementOrder.length > 20
```
Falls back to `strictLayoutScoreOrder` whenever depths differ **even if both
exceed 20** — i.e. the scale-aware banding is only applied to same-depth
comparisons. As established in §1, **this entire dispatcher and both order
chains are dead for production** Compact/Compact Short Side under default
settings (only `windowedBeam.ts` invokes `.compare`), but they are
externally exported/tested (§14) and referenced in the migration prompt's
list of concrete search behavior to preserve — see §15 for the scope
question this raises.

`collisionBoundsMaxSideMm` (557-564): derives `max(width, height)` from
`spanMm = width + height` and `areaMm2 = width * height` alone (the actual
`width`/`height` are not stored on `IrregularLayoutScore`), solving the
quadratic `t² − spanMm·t + areaMm2 = 0` for its larger root:
`discriminant = max(0, spanMm² − 4·areaMm2)`; `maxSide = (spanMm +
sqrt(discriminant)) / 2`. The `max(0, ...)` guard exists because floating
rounding could otherwise make the discriminant slightly negative when
`width === height` exactly. See §7 for the numeric-precision implications of
reconstructing `max(width,height)` this way instead of storing it directly.

### 6.3 Tie chains not expressed as `Order` objects

`compareInternalPoints` (irregularLayoutScorer.ts:502-504): `first.x -
second.x || first.y - second.y` — a **raw arithmetic-subtraction
comparator** passed to `Array.prototype.sort` inside `convexHull` (line
462). This is a different idiom from every other comparator in this cluster
(which use `effect`'s `Order`), and it has different edge-case behavior: for
non-integer/huge-magnitude differences it can return a comparator value
whose *sign* doesn't match a true `<`/`>`/`===` decision only in
pathological float-cancellation cases (not a practical concern for
finite/validated mm coordinates, but a Rust port using `f64::partial_cmp`
must confirm it never receives a `NaN` here — the caller already validates
`Number.isFinite` for every point at line 427-429 before calling
`convexHull`, so this is provably safe **provided that same validation
order is preserved**).

---

## 7. Numeric semantics

### 7.1 `irregularScoreGrid.ts` — the canonical rounding rule (used everywhere)

`canonicalizeIrregularScoreMillimeterUnits(valueMm)` (21-30):
```
if (!Number.isFinite(valueMm)) return undefined
scaledAbsoluteValue = Math.abs(valueMm) * 1000   // IRREGULAR_SCORE_GRID_SCALE = 1 / 0.001
if (!Number.isFinite(scaledAbsoluteValue)) return undefined
roundedAbsoluteValue = Math.floor(scaledAbsoluteValue + 0.5)   // round-half-away-from-zero on the *absolute* value
gridValue = Math.sign(valueMm) * roundedAbsoluteValue
return Number.isSafeInteger(gridValue) ? gridValue : undefined
```
This is **round-half-away-from-zero** at a fixed 0.001 mm grid, implemented
via `Math.floor(abs(x) + 0.5)` then reapplying the original sign via
`Math.sign` — **not** `Math.round` (which is round-half-toward-positive-infinity
and would give different results for negative half-way values: `Math.round(-0.5)
=== -0` but this code's approach gives `Math.sign(-0.5)*Math.floor(0.5+0.5) =
-1*1 = -1`). A Rust port must implement this exact algorithm (`(x.abs() *
1000.0 + 0.5).floor() * x.signum()`, but see the `-0`/`Math.sign` caveat
below — Rust's `f64::signum()` returns `1.0`/`-1.0`/`NaN` and, critically,
`0.0_f64.signum() == 1.0` and `(-0.0_f64).signum() == -1.0` — matching JS's
`Math.sign(0) === 0` / `Math.sign(-0) === -0` is **not** the same convention;
a literal `Math.sign` port needs a custom function, not `f64::signum()`,
because JS's `Math.sign(0)` is `0` (a real zero used in subsequent
multiplication as `0 * roundedAbsoluteValue`), whereas Rust's `signum()`
would give `1.0` for `+0.0`. Concretely, for `valueMm = 0`:
`Math.sign(0) = 0`, `gridValue = 0 * roundedAbsoluteValue`, and since
`roundedAbsoluteValue = Math.floor(0+0.5) = 0`, `gridValue = 0 * 0 = 0`
(ordinary positive zero — `0 * 0` is `+0` in IEEE 754, not `-0`). For
`valueMm = -0`: `Math.abs(-0) = 0` (positive), same
`roundedAbsoluteValue = 0`, but `Math.sign(-0) = -0`
(JS-specific: `Math.sign` preserves the sign of zero), so `gridValue = -0 *
0 = -0` (IEEE 754 sign-of-product rule: negative × positive = negative,
magnitude 0 ⇒ `-0`). **`Number.isSafeInteger(-0)` is `true`** in JS, so this
function can return a literal `-0`, not normalized away at this layer.

`canonicalizeIrregularScoreMillimeters(valueMm)` (15-18): calls the above,
then divides the integer grid units back by the same scale
(`gridUnits / 1000`) to return a millimeter-scale `number`. This is the
function used by score computation (`irregularPlacementScorer.ts`,
`irregularLayoutScorer.ts`) — its output can also be a literal `-0` for the
same input class as above (`-0 / 1000 = -0`). Downstream, `Order.Number`
treats `+0`/`-0` as equal (§6), so ranking is unaffected, but any code that
does `Object.is(value, -0)` or serializes via a formatter that doesn't
normalize `-0` (unlike `JSON.stringify`/`String`, which both normalize `-0`
to `"0"` per ECMA-262 `Number::toString`) could observe it.

`canonicalizeIrregularScoreScalar(value)` (33-42): identical algorithm at a
different scale (`IRREGULAR_SCORE_SCALAR_STEP = 0.000001`, i.e. six decimal
digits), used for dimensionless values (`occupiedHullWasteRatio`,
`sharedCollisionBoundaryContactUnits`). Also divides back to the original
scale before returning (unlike the millimeter-*units* variant, there is no
"return raw grid units" sibling function exposed for the scalar case).

### 7.2 The canonical-key coordinate quantization (irregularBeamState.ts)

`normalizeCanonicalCoordinate(value)` (852-857):
```
canonicalizeIrregularScoreMillimeterUnits(value) ?? (Object.is(value, -0) ? 0 : value)
```
**This returns the integer grid-unit count** (not millimeters) when the
value is finite and safe — i.e. canonical geometry keys encode coordinates
scaled by 1000 (micrometers-as-integers on the 0.001 mm grid), reusing the
exact same rounding rule as score canonicalization (§7.1). This is a
non-obvious but load-bearing fact: **the score-canonicalization grid and the
canonical-key coordinate grid are the same module and the same constant**
(`IRREGULAR_SCORE_GRID_STEP_MM = 0.001`), even though `irregularScoreGrid.ts`'s
name and doc-comments frame it as being about *scoring*. The fallback branch
(`Object.is(value,-0) ? 0 : value`) only fires when the primary call returns
`undefined` (non-finite, or the scaled/rounded value exceeds
`Number.MAX_SAFE_INTEGER`) — in which case the **raw, unrounded** value
(mm-scale, not grid-unit-scale) is passed through instead, silently mixing
units within the same key-building function for the pathological case. This
fallback is very unlikely to be exercised by real geometry (would require a
coordinate whose absolute value exceeds roughly `9×10^12` mm) but must still
be replicated for the migration prompt's "do not introduce behavior changes"
rule; see §12 for the `String(value)`/exponential-notation hazard this
fallback creates downstream in `canonicalNumber`.

`canonicalNumber(value)` (844-850):
```
if (Number.isNaN(value)) return 'NaN'
if (Object.is(value, -0)) return '0'
if (value === Infinity) return '+Infinity'
if (value === -Infinity) return '-Infinity'
return String(value)
```
This is the **second, independent** signed-zero normalization in this
cluster (the first being inside `normalizeCanonicalCoordinate`'s fallback
branch) — it normalizes `-0` to the string `'0'` regardless of how the
numeric `-0` arose, so the net effect is that **canonical key text is always
free of signed-zero divergence** even though intermediate numeric values
along the way (`normalizeCanonicalCoordinate`'s return value,
`rotateQuarterTurnPoint`'s output) can be literal `-0`. `String(value)` for
the ordinary case (an integer grid-unit count, e.g. `1500`) prints plain
decimal digits with no fractional point (JS integers print without `.0`).
For the fallback (rare, raw mm value) path, `String(value)` follows
ECMA-262 `Number::toString`, which switches to exponential notation outside
roughly `[1e-6, 1e21)` — **Rust's default `f64` `Display`/`to_string()` never
uses exponential notation and uses a different shortest-round-trip
algorithm**, so a Rust port must implement an ECMA-262-compatible
`Number::toString` specifically to keep this fallback path byte-identical
(or prove the fallback is unreachable for all geometry the algorithm can
legally produce, given upstream padding/sheet-size bounds enforced
elsewhere, and gate it with an explicit panic/error instead — a decision
for the orchestrator, flagged in §15).

`normalizeNegativeZero(value)` (496-498): `Object.is(value, -0) ? 0 : value`
— used inside `rotateQuarterTurnPoint` (475-489) for every rotated
coordinate (`-point.y`, `-point.x` at 90°/180°/270°) to prevent `-0` from
propagating into the rotated `IrregularPoint`/translation values *before*
they reach `normalizeCanonicalCoordinate`/`canonicalNumber`. Given both of
those downstream functions already neutralize `-0` on their own, this
appears to be **defense-in-depth / consistency for intermediate values**
(e.g. so that `Object.is`-based equality checks elsewhere in the broader
codebase, outside this cluster, that might compare raw rotated coordinates
before they reach a canonical key, see consistent `+0` rather than `-0`) —
replicate it exactly regardless (per the migration prompt's explicit
"preserve signed-zero handling" requirement, §9), since proving it is
*completely* unobservable would require tracing every consumer of rotated
`IrregularPoint`/transform values outside this cluster.

### 7.3 `Math.*` calls inventory (this cluster only)

| Call | File:line | Purpose |
|---|---|---|
| `Math.abs` | irregularScoreGrid.ts:24,36 | absolute value before grid scaling |
| `Math.floor` | irregularScoreGrid.ts:27,39; irregularLayoutScorer.ts:274,538,592 (dead path) | round-half-away-from-zero construction (§7.1); band-flooring for structural-contact bands |
| `Math.sign` | irregularScoreGrid.ts:28,40 | reapply original sign after rounding the absolute value (§7.1, `-0` hazard) |
| `Math.min`/`Math.max` | irregularBeamState.ts:511-514,933-936,965-968; irregularPlacementScorer.ts:376-379,408-411,235,244-247 (`Math.max` for `worstNormalizedSheetConsumption`); irregularLayoutScorer.ts:259,360 | bounds unions (associative, order-independent — see §7.4), worst-axis-consumption selection |
| `Math.hypot` | irregularLayoutScorer.ts:407 (`polygonPerimeter`) | Euclidean edge length; **not** used for the beam-state contact length (that comes from `convexPolygonContact.ts`, a different cluster) |
| `Math.sqrt` | irregularLayoutScorer.ts:563 (`collisionBoundsMaxSideMm`, dead-for-production) | quadratic-formula root |
| `Object.is` | irregularBeamState.ts:481,483,485,487,497,846,853,855; irregularLayoutScorer.ts (none directly) | exact `-0`/`NaN` identity checks, never `===`/`==` |
| `Number.isFinite` | pervasive in all four scoring/state files | validates every derived numeric field before acceptance; **the single most repeated guard in this cluster** |
| `Number.isSafeInteger` | irregularScoreGrid.ts:29,41; irregularBeamState.ts:566,625,668,690,702; irregularLayoutScorer.ts:292,294,297,298 | bounds overflow guard on integer-valued derived counts/grid units |
| `Number.isNaN` | irregularBeamState.ts:845; irregularLayoutScorer.ts (via `Number.isFinite`, which subsumes NaN-rejection, so no separate explicit `isNaN` call in that file) | |

### 7.4 Floating-point summation order — the sharpest hazard in this cluster

**Bounds unions are associative and commutative** (`Math.min`/`Math.max` of
finite numbers): `derivePlacedCollisionBounds` (irregularBeamState.ts:918-959,
per-piece), `unionCollisionBounds`/`extendCollisionBounds` (907-982,
pairwise), and `deriveCollisionBounds` (890-905, full fold) all compute the
same result **bit-for-bit regardless of accumulation order**, because
`min(min(a,b),c) === min(a,min(b,c))` exactly for IEEE 754 doubles without
NaN. **This is not true for the shared-boundary-length sum.**

`deriveSharedCollisionBoundaryMetrics` (541-580, used by fresh/from-scratch
derivation) computes, for each `entry` in `index.entries` (ordinal-ascending
= placement order), `additional = sharedBoundaryWithEntries(entry,
index.entries.slice(0, entry.ordinal))` — **all** prior entries by ordinal,
unconditionally — and accumulates `totalLengthMm += additional.lengthMm`
(553) across entries. Inside `sharedBoundaryWithEntries` (638-682), for each
`existingEntry` in that same ordinal-ascending slice, it accumulates
`totalLengthMm += contact.lengthMm` (654). The **exact nested summation
order** is: outer `j` from `0` to `N−1` (entry ordinal), inner `i` from `0`
to `j−1` (prior entry ordinal), i.e. Σ_{j=0}^{N−1} Σ_{i=0}^{j−1}
contact(entry_j, entry_i), each inner sum computed left-to-right and each
outer accumulation left-to-right.

`extendSharedCollisionBoundaryMetrics` (582-636, used by the incremental
`.withPlacement` path) instead computes `additional =
sharedBoundaryWithEntries(addedEntry, existingIndex.query(addedEntry.indexedBounds))`
(603-606) — **`existingIndex.query(...)`, not a full ordinal slice.**
`query()` (`placedCollisionSpatialIndex.ts:129-156`) returns only entries
whose axis-aligned bounds are **not disjoint** from the query bounds (plus
any entry that failed geometry validation, unconditionally — see
`placedCollisionSpatialIndex.ts:147-155`), filtered from the same stable
ordinal-ordered `entries` array, so the *relative order* of whatever subset
it returns still matches ordinal order — but it is genuinely a **subset**
when any prior piece's bounding box is spatially disjoint from the new
piece's bounding box.

**These two code paths are only guaranteed to produce bit-identical sums if
every bbox-disjoint pair's `measureSharedConvexPolygonBoundaryContact`
result is a literal exact `0.0`** (not a tiny nonzero epsilon), because
IEEE 754 `x + 0.0 === x` exactly for any finite `x`. This is geometrically
plausible (non-overlapping bounding boxes cannot have touching polygon
boundaries) but this cluster's files do not prove it — the proof, if it
exists, lives in `src/workers/irregular/convexPolygonContact.ts` (a
different cluster). **A Rust port must not "optimize" by unifying these two
summation strategies into one shared function without an explicit
differential test proving `deriveSharedCollisionBoundaryMetrics` applied to
a state's full `placedCollisionGeometries` produces a bit-identical
`sharedCollisionBoundaryLengthMm`/`sharedCollisionBoundaryContactUnits`/
`nearCompleteStructuralContactCount` to the same state built via a chain of
`.withPlacement` calls.** This equivalence is currently *implicitly* relied
upon by production code (fresh reconstructions at result-materialization
time, §1.2, use the from-scratch path; the live search itself uses the
incremental path) but is not itself unit-tested as an explicit equivalence
in this repository as far as this cluster's file list shows (flagged in
§14/§15 as a test gap to close before/during the Rust port, not merely to
port).

### 7.5 BigInt usage

**None** in this cluster's five files (`Grep -n "BigInt"` across all five:
no matches). BigInt-based exact arithmetic lives in the geometry/canonical-grid
cluster (`canonicalGridMath.ts` etc., per `AGENTS.md:29-30` and the migration
prompt §8.2), not here. This cluster's numeric authority is entirely
`Number`/`f64`, protected by the `Number.isFinite`/`Number.isSafeInteger`
guards inventoried above.

---

## 8. Serialization and hashing

### 8.1 The canonical-key encoding scheme (irregularBeamState.ts)

`canonicalToken(value: string): string` (840-842): `` `${value.length}:${value}` ``
— a length-prefixed ("netstring"-style) token. `canonicalRecord(fields:
ReadonlyArray<ReadonlyArray<string>>): string` (829-838): concatenates
`canonicalToken(name) + canonicalToken(value)` for each `[name, value]`
pair, in **array literal order** (not sorted — the caller is responsible for
supplying fields in the desired order; every call site in this file supplies
a fixed literal order). Field pairs with `undefined` name or value are
silently skipped (`if (name === undefined || value === undefined) return
''`), which is dead code in practice since every call site supplies fully
literal 2-tuples, but must still be replicated for exactness.

Composition, outer to inner:
- `canonicalEntryListKey(entryKeys)` (859-865): `canonicalRecord([['version',
  'irregular-occupied-geometry-v2'], ['entry-count',
  canonicalNumber(entryKeys.length)], ...entryKeys.map((k, i) =>
  [\`entry-${i}\`, k])])` — **the version string
  `'irregular-occupied-geometry-v2'` is a hard-coded literal embedded in
  every occupied-geometry key**; bump/versioning discipline for this string
  belongs to whoever next changes the encoding, but a Rust port must embed
  it byte-identical.
- `canonicalCollisionPolygonKey(points, translateX=0, translateY=0)`
  (744-752): `canonicalRecord([['polygon-ring', canonicalRingKey(points,
  translateX, translateY)]])`.
- `canonicalRingKey` (765-818): builds `point-count` + one `point-{offset}`
  token per vertex, each value itself a `canonicalPointKey` string (a
  canonical-key-within-a-canonical-key, since `canonicalToken` length-prefixes
  the *entire* nested token string, making the encoding self-delimiting and
  collision-free regardless of what characters appear inside coordinate
  strings).
- `canonicalPointKey(x, y)` (820-827): `canonicalToken('x') +
  canonicalToken(canonicalNumber(x)) + canonicalToken('y') +
  canonicalToken(canonicalNumber(y))`.

This scheme's self-delimiting length-prefix property is exactly the
"separator bytes" concern the migration prompt §9 calls out — **a Rust port
must reproduce `canonicalToken`'s `"{len}:{value}"` format exactly**,
including using the **UTF-16 code-unit length** JS's `.length` reports for
`value` (not a byte length, not a Unicode scalar/grapheme count) if `value`
ever contains non-ASCII characters. In practice every string fed through
this cluster's canonical-key machinery is ASCII (field names, `canonicalNumber`
output, `'NaN'`/`'+Infinity'`/`'-Infinity'`/`'0'`), so UTF-16-length and
byte-length coincide today — but a Rust implementation using `.len()` on a
`String` (UTF-8 byte length) would only match by coincidence for ASCII input
and must not be assumed to be "the same idea" if any future field is
non-ASCII; a Rust port should compute length identically to
`String.prototype.length` (UTF-16 code units) as a matter of principle, or
prove ASCII-only invariance and document that as a requirement of any code
that appends new fields to these records.

### 8.2 `canonicalNumber`'s number-to-string rule (recap of §7.2)

`NaN → 'NaN'`, `-0 → '0'`, `+Infinity → '+Infinity'`, `-Infinity →
'-Infinity'`, else `String(value)` (ECMA-262 `Number::toString`). For the
overwhelmingly common case (finite, safe-integer grid-unit coordinates or
small non-negative integer counts), this is plain decimal digits with no
special formatting.

### 8.3 `JSON.stringify` usage in this cluster

- `IrregularBeamState.continuationMetadataIdentity()` (149-156) and its two
  helpers `canonicalEntryContinuationIdentity()` (158-160, `JSON.stringify(this.canonicalEntryKeys)`)
  and `contactSignatureContinuationIdentity()` (162-170, `JSON.stringify` of
  a sorted array of `[signature, count]` pairs, or `JSON.stringify(undefined)`
  which yields the string `"undefined"`... **note: `JSON.stringify(undefined)`
  actually returns the value `undefined` (not a string!)** at the top level in
  JS — but here it's nested inside an outer `JSON.stringify({..., placedCollisionIndex:
  ...})` call at the `continuationMetadataIdentity()` level, and *inside*
  an object/array, `JSON.stringify` renders `undefined` values as the JSON
  literal `null` (for object properties) or drops them (would need
  verification for the array-nested case here, but `contactSignatureContinuationIdentity()`
  is called standalone too, at which point `JSON.stringify(undefined)` returns
  the *JavaScript `undefined` value*, not a string `"undefined"`). **This is a
  precise, easy-to-get-wrong hazard**: `contactSignatureContinuationIdentity()`'s
  return type is declared `string` (line 162) but when
  `this.nearCompleteStructuralContactSignatureCounts === undefined`, the
  function body is `JSON.stringify(undefined ? ... : undefined)` →
  `JSON.stringify(undefined)` → **the JS value `undefined`, not the string
  `"undefined"`** — TypeScript's structural typing does not catch this at
  compile time because `JSON.stringify`'s type signature is `(value: any) =>
  string`, which is technically incorrect for this input (a known TS stdlib
  typing gap). A Rust port must decide what the *actual* runtime value is
  here (`undefined`, coerced to the string `"undefined"` only if concatenated
  into a template literal elsewhere, or literally `undefined`/absent if used
  as an object value) and reproduce that, not the declared type. Flagged
  prominently in §15 as a correctness question to resolve empirically
  (`node -e` a repro) before porting.
- `makeFreeMaterialCacheKey` (irregularLayoutScorer.ts:36-55): `JSON.stringify({version:
  FREE_MATERIAL_CACHE_VERSION /* 'irregular-free-material-v1' */, sheet:
  {width, height, label}, geometrySettings: {flatteningSagToleranceMm,
  clearanceSafetyMarginMm, geometryBackendId, geometryBackendVersion},
  placedGeometry: input.state.canonicalOccupiedGeometryKey})` — object
  key order here is **source-literal order** (JS object property insertion
  order for string keys is preserved by `JSON.stringify`, and this literal's
  keys are written in a fixed order in source), so this is safe/deterministic
  as written, but a Rust port building an equivalent cache key must replicate
  the exact key **order and nesting**, not just the value set, if it wants
  byte-identical keys (the key is only used for an in-process `Map` lookup,
  never persisted or hashed externally, so byte-identical keys only matter
  for **internal cache-hit-rate parity**, not for any external contract —
  see §9).
- `PlacedCollisionSpatialIndex.continuationIdentity()`
  (`placedCollisionSpatialIndex.ts:118-127`, a sibling file called by
  `IrregularBeamState.continuationMetadataIdentity()` at line 154) also uses
  `JSON.stringify` with an explicit `.toSorted(([first],[second]) =>
  first.localeCompare(second))` on its bucket-key array before stringifying
  — same locale-sensitivity caveat as §5.3.

### 8.4 What does *not* feed SHA-256 in this cluster

None of the string/key-building functions in this cluster's five files call
or feed a SHA-256/hash function directly. The "canonical geometry hash"
(`sheetlessCanonicalGeometryHash`, `canonicalGeometryHash` seen throughout
`computeIrregularNesting.ts`) is a **separate canonicalization system**
built on Clipper2 integer Boolean geometry (per the migration prompt §8.3
and `AGENTS.md:29-30`), living in a different cluster's files (most likely
`canonicalLayoutGeometry.ts`/`geometryCacheIdentity.ts`, out of scope here).
**Do not conflate `IrregularBeamState`'s `canonicalOccupiedGeometryKey`
(a float-grid vertex-coordinate string key used for in-memory search-state
dedup) with the SHA-256 `canonicalGeometryHash` used for archive/checkpoint
identity** — they serve different purposes, are computed by different code,
and there is no evidence in this cluster that one is derived from the other.
This distinction should be stated explicitly in whatever document
characterizes the geometry/hashing cluster, and is called out here as an
open cross-cluster question (§15).

---

## 9. Caches touched and the exact historical access sequence

### 9.1 The free-material cache (`irregularLayoutScorer.ts`, the only true cache in this cluster)

State: `freeMaterialCache = new Map<string, FreeMaterialSnapshot>()`
(line 126), instantiated once per `IrregularLayoutScorer.Make` /
`.Layer` construction (i.e. **once per job**, not shared across jobs — see
migration prompt §13.6 "job-local ownership" default). Bound:
`MAX_FREE_MATERIAL_CACHE_ENTRIES = 256` (line 32).

Exact access sequence inside `scoreState` (128-148) →
`computeSnapshotWithParentFallback` (156-204):

1. **Key construction**: `cacheKey = makeFreeMaterialCacheKey(input,
   settings)` (line 130) — see §8.3 for exact shape. Built from `sheet.width/height/label`,
   four geometry-settings fields, and `input.state.canonicalOccupiedGeometryKey`
   (irregularBeamState.ts's own canonical key — so this cache's key space is
   already downstream of §8.1's encoding).
2. **Direct lookup**: `freeMaterialCache.get(cacheKey)` (line 131).
3. **On hit**: `Effect.succeed(cachedSnapshot)` (line 140) — no further work,
   proceeds straight to `scoreDerivedState` (line 143).
4. **On miss**, `computeSnapshotWithParentFallback` runs (134-139, 156-204):
   a. Reads `parent = input.state.parent` (line 165) and
      `newlyPlaced = getNewlyPlacedGeometry(input.state)` (line 166,
      206-222 — requires `state.placedCollisionGeometries.length ===
      parent.placedCollisionGeometries.length + 1` **and** every prior
      index to be reference-`!==`-clean against the parent's array, else
      returns `undefined`).
   b. Looks up the **parent's own cache entry** by a *separately computed*
      cache key (`makeFreeMaterialCacheKey({sheet, state: parent},
      settings)`, line 170) — **a second, independent `Map.get`, not a
      pointer/parent-link lookup** — so this only succeeds if the parent
      state was itself scored (and thus cached) earlier in the *same job*.
   c. If both (b) succeeded and `newlyPlaced !== undefined`: attempts the
      incremental path `freeMaterialService.extendFreeMaterial({parent:
      parentSnapshot, placed: newlyPlaced, settings})` (182-187), and on
      **any** Effect failure from that call, falls back to the full path
      via `Effect.catch(() => full())` (line 188) — i.e. incremental failure
      is silently absorbed and retried from scratch, never surfaced as an
      error.
   d. Else (no parent snapshot cached, or no clean single-piece diff):
      `full()` (172-177) — `freeMaterialService.computeFreeMaterial({sheet,
      placed: input.state.placedCollisionGeometries, settings})`.
   e. **Publication**: on success of either (c) or (d),
      `Effect.tap(snapshot => Effect.sync(...))` (190-203) evicts if at
      capacity (`if (freeMaterialCache.size >= 256) { oldestKey =
      freeMaterialCache.keys().next().value; delete }`, lines 193-195 —
      **FIFO by `Map` insertion order**, see §5.3/§12), then **always**
      `freeMaterialCache.set(makeFreeMaterialCacheKey(input, settings),
      snapshot)` (196-200) — recomputes the cache key a **third time**
      (once at step 1, once implicitly for the eviction check, once here)
      rather than reusing the `cacheKey` local from step 1 (a real,
      textually-visible inefficiency, but not a correctness issue since
      it's the same deterministic function of the same immutable inputs).
5. Whatever snapshot resulted feeds `scoreDerivedState(input, snapshot)`
   (line 143, 224-326) for the actual numeric score computation — the cache
   layer's only effect on *values* (not performance) would be if
   `extendFreeMaterial`'s incremental result differs numerically from
   `computeFreeMaterial`'s full result for logically-equivalent input — a
   question this cluster's files cannot answer (the two methods are
   implemented in `freeMaterialService.ts`, a different cluster) but which
   is **directly observable** if it happens, since the score summary is
   externally visible output (§3.4). Flagged in §15.

### 9.2 Production usage frequency (established in §1.2/§2.4)

Because `layoutScorer.scoreState` is called **exactly once per completed
production job** (one of four mutually-exclusive `materialize*` call sites
in `computeIrregularNesting.ts`), the free-material cache and its
parent-extension fast path are, in production, essentially **single-shot**:
one miss, one `full()` computation (since there is no `.parent` state
already cached from a prior `scoreState` call within the same job — nothing
else in the production call graph calls `layoutScorer.scoreState` earlier
in the same job), one publish, zero evictions (cache never approaches 256
entries in a single production job under this call pattern). This makes the
cache's *design* (FIFO eviction, parent-fallback, 256-entry bound)
effectively **decorative for current production Compact/Compact Short
Side**, though it is fully exercised by `windowedBeam.ts`'s dead-for-production
beam search (which calls `.scoreState` on every candidate state during
search — see `windowedBeam.ts:895,1075,1983`) and by the direct unit tests
in `tests/unit/irregularLayoutScorer.test.ts` (§14). **A Rust port should
still implement the cache faithfully** (it is reachable code, part of the
public service contract, and exercised by non-default settings/tests per
§1.3), but should not assume it needs to be a high-throughput concurrent
structure for the *default* Compact/Compact Short Side path specifically —
this is useful context for the Stage 3/4 cache-architecture design (migration
prompt §13) when deciding which caches genuinely need sharded/lock-free
designs versus a simple job-local single-threaded structure.

### 9.3 `IrregularBeamState`'s own "caches"

Not caches in the memoization sense, but persistent-across-transitions
derived state that acts like one: `canonicalEntryKeys` (sorted array,
incrementally maintained, §4.1/§5.2), `placedCollisionIndex` (spatial index,
incrementally maintained with a reference-equality reuse guard, §4.6),
`sharedCollisionBoundaryLengthMm`/-related fields (incrementally extended
with the sticky-undefined property, §4.3/§7.4). None of these are ever
invalidated/evicted — they only grow (or go permanently `undefined`) as the
beam-state chain deepens. There is no explicit "stale eviction" step in this
cluster (contrast with the free-material cache's FIFO eviction, or the NFP
cache in a different cluster) — the closest analogue is the reference-equality
distrust in `IrregularBeamState`'s constructor (§4.6), which is a
**validation**, not an eviction.

---

## 10. Cancellation / deadline / budget / evaluation-cap observation points

**None of the five files in this cluster contain a cancellation check, a
deadline check, an evaluation-cap check, or a budget check.** `Grep` for
`isCancelled`, `control.checkpoint`, `deadline`, `evaluationCap`,
`AbortError` across all five files: no matches. `IrregularBeamState`,
`irregularPlacementScorer.ts`, and `irregularLayoutScorer.ts` are pure
data/scoring transformations with no loop of their own long enough to need a
cooperative check (their most expensive internals —
`deriveSharedCollisionBoundaryMetrics`'s O(n²) pairwise loop,
`convexHull`'s O(n log n) sort — are bounded by the number of already-placed
pieces in one job, not by an open-ended search). The actual cancellation/
deadline/evaluation-cap checkpoints for Compact/Compact Short Side live in
the calling search loops (`intrinsicStrictDecoder.ts`, `intrinsicCapacitySearch.ts`,
`intrinsicSharedArchivePortfolio.ts`) — out of this cluster's scope, but
worth stating explicitly here since the migration prompt §15 requires mapping
every observation point: **this cluster has zero of them**, and a Rust port
must not add any here (adding a cooperative check inside, say,
`withPlacement` or `scoreCandidate` would change the migration prompt's
"exact observation point" contract by introducing a new checkpoint that does
not exist in the TS baseline).

The only timing instrumentation in this cluster is **explicitly
non-semantic**: `IrregularBeamState.withPlacement`'s optional
`onPhaseTimings`/`timingNow` parameters (lines 176-178, 179-180, 190-191,
195-196, 209-210, 238-251) — gated entirely by `input.onPhaseTimings !==
undefined`; when the caller does not supply a callback, every `timingNow()`
call is skipped (replaced by the literal `0`) and no `performance.now()` is
invoked at all, so there is zero overhead by default. This produces an
`IrregularBeamStatePlacementPhaseTimings` record (60-67: `canonicalEntryKeyMs`,
`spatialIndexMs`, `contactMeasurementMs`, `stateAssemblyMs`, `bookkeepingMs`
[computed as `Math.max(0, totalMs − sum-of-measured)`, line 248, a
residual/catch-all bucket], `totalMs`) — purely diagnostic, per the
migration prompt §7's non-semantic diagnostic-channel rule; must not leak
into canonical output, hashes, or checkpoints, and none of the callers in
this cluster's Grep results route it anywhere but optional telemetry
callbacks.

---

## 11. Error paths

Two typed `Data.TaggedError` classes, both declared in this cluster and both
listed explicitly in the migration prompt §16's mapping table:

- `IrregularPlacementScoringError` (irregularPlacementScorer.ts:28-33):
  fields `operation: string`, `message: string`. Raised only by
  `failScoring()` (444-451), called from four validation sites inside
  `scoreCandidate` (198-281):
  - line 202: `validateCandidateMetadata` failure (moving-geometry source
    piece id or transform metadata mismatch against the candidate,
    417-430/432-442) — `operation: 'scoreCandidate'` always (448, hardcoded,
    not parameterized per failure site — every error from this file has the
    same `operation` string regardless of which specific check failed; only
    `message` differentiates).
  - line 206: non-finite combined bounds (`makeCombinedBounds` returns
    `undefined`, 352-385).
  - line 210: non-finite shared boundary length (`makeSharedCollisionBoundaryLength`
    returns `undefined`, 315-335).
  - line 231: any of `clusterWidth`/`clusterHeight`/`candidateBottom`/
    `candidateLeft`/`canonicalSharedCollisionBoundaryLengthMm` fails
    grid-canonicalization (returns `undefined` from `irregularScoreGrid.ts`
    functions).
  - line 264: final finite-arithmetic guard across all nine derived score
    fields (252-263) — this is a defensive **second** check of values that
    should already be finite given the upstream canonicalization guards;
    included per the "belt and suspenders" pattern this codebase uses
    throughout (`Number.isFinite` re-checked after every derivation, not
    trusted transitively).
  Maps externally to `irregular_scoring_error` with context `operation`
  (migration prompt §16 table row `IrregularPlacementScoringError`).

- `IrregularLayoutScoringError` (irregularLayoutScorer.ts:22-25): same shape
  (`operation`, `message`). Raised by `failScoring()` (578-585), called from:
  - line 230: `deriveFreeMaterialMetrics` returns `undefined` (a region with
    non-finite area/perimeter, or `netArea <= 0` — line 367, **note this is
    `<= 0`, not `< 0`**, i.e. a zero-net-area region is treated as an error,
    not silently skipped or zero-weighted).
  - line 248: any of `canonicalWidth`/`canonicalHeight`/`canonicalMinX`/
    `canonicalMinY` fails grid-canonicalization.
  - line 236 (a plain early-return via `failScoring`, not inside the big
    `if`): `collisionBounds === undefined` — i.e. `state.translatedCollisionBounds`
    was `undefined` (the "sticky undefined" propagation from §4.3/§4.7's
    incremental-extend chain reaching a non-finite coordinate at some
    ancestor placement).
  - line 304: final finite-arithmetic guard, same "belt and suspenders"
    pattern, across ~13 conditions (282-303) including range checks not
    seen in the placement scorer (`nearCompleteStructuralContactCount < 0`,
    `dominantNearCompleteStructuralContactCount < 0`,
    `dominantNearCompleteStructuralContactCount >
    nearCompleteStructuralContactCount` — an **invariant check between two
    derived fields**, not just a finiteness check; this is the only
    cross-field invariant assertion in either scorer file).
  Also, `IrregularLayoutScorer`'s dependency chain can propagate
  `IrregularGeometryInputError`/`IrregularNestingNotImplementedError` from
  `FreeMaterialService` (type union at lines 101-104) — these are
  **not defined in this cluster**; they originate in
  `src/workers/irregular/services.ts` (different cluster) and simply pass
  through `computeSnapshotWithParentFallback`'s return type unchanged.
  Maps externally to `irregular_scoring_error` with context `operation`
  (migration prompt §16 table row `IrregularLayoutScoringError`; note both
  `IrregularPlacementScoringError` and `IrregularLayoutScoringError` map to
  the **same** external code, `irregular_scoring_error` — a many-to-one
  mapping the migration prompt explicitly documents and requires be
  preserved, not flattened further or split apart).

`sortPiecesForNesting` and `irregularScoreGrid.ts` have **no error type at
all** — `sortPiecesForNesting` is a total function over any well-typed input
(cannot fail; `RectWith`'s schema already guarantees `longestEdge`/`area`/
`imbalance` are finite integers before this function ever sees them), and
`irregularScoreGrid.ts`'s functions return `number | undefined` rather than
throwing or using an `Effect` failure channel — callers are responsible for
turning `undefined` into a typed error (which both scorer files do, per
above).

`IrregularBeamState`'s methods are **not** `Effect`-wrapped and do not throw
— non-finite conditions are represented as `undefined` return values
(`withBottomLeftAnchored`, `bottomLeftAnchoredCanonicalOccupiedGeometryKey`,
`withQuarterTurnBottomLeft` — all `T | undefined` return types) rather than
exceptions or typed errors. Callers outside this cluster
(`intrinsicStrictDecoder.ts`, `intrinsicCapacitySearch.ts`) are responsible
for treating `undefined` as "this candidate/state is invalid, discard it" —
this cluster's files never themselves decide what an `undefined` bounds/key
*means* for search control flow (per `AGENTS.md`'s architecture split:
`src/workers/irregular/` geometry kernels "must not invent placements,
scores, history, or search behavior" — `IrregularBeamState` sits in
`src/workers/algorithm/irregular/`, so this rule doesn't literally apply to
it, but its actual design still follows the same separation: it reports
validity, callers decide policy).

---

## 12. JS-specific semantics hazards for a Rust port

Consolidated from findings threaded through §5-§9 above, listed here as a
single checklist:

1. **Stable sort reliance.** `sortPiecesForNesting`'s `Array.prototype.toSorted`
   (sortPiecesForNesting.ts:17) and `irregularBeamState.ts`'s three
   `.toSorted(compareCanonicalKeys)` call sites (318, 438, 523) all rely on
   ECMA-262-guaranteed stable sort. Rust's `slice::sort_by` is stable;
   `sort_unstable_by` is not — use the former, or carry explicit original
   indices as an extra tie-break if using an unstable sort for performance.
2. **Two distinct string-ordering regimes coexist in this cluster and must
   not be conflated**: plain UTF-16 code-unit `<`/`>` (`compareCanonicalKeys`,
   irregularBeamState.ts:867-871, and `Order.String` throughout
   `irregularPlacementScorer.ts`/`irregularLayoutScorer.ts`'s `Order.Array(Order.String)`
   tie-breaks) versus **locale-sensitive** `String.prototype.localeCompare`
   (irregularBeamState.ts:167, and `placedCollisionSpatialIndex.ts:124`,
   both used only for `Map`-entry-sorting-before-serialization in
   continuation-identity strings). A Rust port needs two different string
   comparison strategies, not one, and must confirm which JS runtime/ICU
   locale data produced any existing `localeCompare`-derived golden fixture
   before choosing a Rust locale library (or prove `localeCompare` is
   equivalent to codepoint order for the ASCII-only signature strings
   actually produced here, which is very likely true in practice but not
   proven within this cluster's files — the signature strings originate in
   `convexPolygonContact.ts`, a different cluster).
3. **`Map` insertion-order-dependent FIFO eviction**: `irregularLayoutScorer.ts`'s
   `freeMaterialCache` (line 194, `freeMaterialCache.keys().next().value`)
   requires an ordered-map structure in Rust (`indexmap::IndexMap` or a
   parallel `VecDeque`), not `std::collections::HashMap`.
4. **`JSON.stringify` of `undefined`** (§8.3): `contactSignatureContinuationIdentity()`
   (irregularBeamState.ts:162-170) can return the JS runtime value
   `undefined` despite its `string` return-type annotation, when
   `nearCompleteStructuralContactSignatureCounts` is `undefined`. Must be
   empirically confirmed (not just read from the type signature) before
   porting, because TypeScript's `JSON.stringify` typing does not surface
   this at compile time.
5. **Signed zero (`-0`)**: appears transiently in
   `canonicalizeIrregularScoreMillimeterUnits`/`canonicalizeIrregularScoreMillimeters`
   (irregularScoreGrid.ts, §7.1), `normalizeCanonicalCoordinate` (irregularBeamState.ts:852-857),
   `canonicalNumber` (844-850, normalizes it to `'0'`),
   `normalizeNegativeZero`/`rotateQuarterTurnPoint` (475-498). `Math.sign(0)
   === 0` and `Math.sign(-0) === -0` in JS — Rust's `f64::signum()` does
   **not** replicate this (`0.0_f64.signum() == 1.0`); a literal port needs
   a custom sign function, not `f64::signum()`.
6. **`Order.Number`'s NaN/zero semantics are non-obvious and must be a
   custom Rust total-order function**, not `f64::total_cmp` (which
   distinguishes negative/positive NaN payloads and treats `-0.0 < 0.0`) and
   not `f64::partial_cmp` (which returns `None`/panics-if-unwrapped on
   `NaN`). The exact required semantics (§6): all NaNs mutually equal and
   sort before every non-NaN; `+0`/`-0` equal. This applies to every
   `Order.mapInput(Order.Number, ...)` term in
   `irregularPlacementScorer.ts`/`irregularLayoutScorer.ts` (dead-for-production
   comparators, but still part of the public service contract per §1.3/§15)
   and, if `Order.Number`-equivalent logic is reused anywhere else in the
   broader port, everywhere else too.
7. **`String(value)` / `Number::toString` exponential-notation threshold**
   (§7.2, §8.2): only reachable via `canonicalNumber`'s fallback path for
   non-finite/overflowing coordinates; JS switches to exponential notation
   outside `[1e-6, 1e21)`, Rust's default `f64::to_string()` never does.
   Needs either an ECMA-262-compatible formatter or a proof of
   unreachability plus an explicit error/panic substitute.
8. **Object reference equality (`===`) used as a real invariant, not
   incidentally**: `PlacedCollisionSpatialIndex.matches()`
   (`placedCollisionSpatialIndex.ts:106-116`, called from
   `irregularBeamState.ts:122`) and `getNewlyPlacedGeometry`
   (irregularLayoutScorer.ts:206-222, `state.placedCollisionGeometries[index]
   !== parent.placedCollisionGeometries[index]`) both require **pointer/reference**
   identity between specific array elements across two related but distinct
   `IrregularBeamState` instances. A Rust port must preserve this identity
   relationship explicitly (e.g. via `Arc<IrregularPlacedPiece>` and
   `Arc::ptr_eq`, or index/generation tagging), not silently switch to
   structural/value equality, because value-equal-but-distinct pieces
   (which could arise from independently reconstructed geometry with
   identical coordinates) must **not** satisfy these checks in the TS
   baseline and must not satisfy them in Rust either — otherwise the
   free-material cache's parent-extension fast path (§9.1) or the spatial
   index reuse guard (§4.6) could silently activate in cases where the TS
   baseline would have taken the slower/from-scratch path, which is
   performance-only *if* the two computations are provably equivalent
   (§7.4/§9.1's open question) but could be a correctness divergence
   otherwise.
9. **`Object.freeze`** (irregularBeamState.ts:317, 437, 522, 887) is a
   runtime immutability enforcement with no direct Rust analogue needed
   (Rust's ownership model gives this for free via `&[T]`/immutable
   bindings) — not a hazard, just noting it has no port-time cost, listed
   here only so it isn't mistaken for a missing behavior.
10. **`Array.prototype.slice(1)` and similar allocations inside hot loops**
    (e.g. `boundsForPoints`, irregularBeamState.ts:510; `translatedBounds`,
    irregularPlacementScorer.ts:404) are performance-only concerns (each
    allocates a new array copy) — semantically inert, safe to replace with
    iterator-based loops in Rust starting from index 1, but noted because a
    literal line-by-line port might otherwise reproduce the allocation
    needlessly.

---

## 13. Parallelism assessment

### 13.1 Safe/pure/independent candidates

- **`sortPiecesForNesting`**: a single total sort over the whole piece list,
  called once per job before any search state exists. No internal
  parallelism opportunity worth pursuing (piece counts are small — tens,
  not millions), but the function itself has zero hidden state and is
  trivially safe to call from any thread; the sort key computation
  (`piece.paddedBounds.longestEdge/area/imbalance`, all pre-computed
  integers on the input) requires no work per comparison.
- **`irregularScoreGrid.ts`**: every function is a pure, allocation-free
  `number -> number | undefined` transform with no shared state — trivially
  parallel-safe, call from any thread, no synchronization needed ever.
- **`irregularPlacementScorer.ts`'s `scoreCandidate`** (198-281): pure given
  its inputs (`sheet`, `placed` snapshot, `moving`, `candidate`) — reads no
  mutable shared state, writes none. **Independent candidate scoring within
  one already-generated, already-ordered candidate batch** is exactly the
  pattern the migration prompt §14.1 lists as a good Rayon candidate ("independent
  candidate legality or score evaluation within one already ordered
  candidate batch"). The live production call site
  (`intrinsicCapacitySearch.ts:654`, inside a `for (const candidate of
  legalCandidates)` loop, lines 623-684) evaluates candidates strictly
  serially today, but each iteration's `scoreCandidate` call is provably
  independent of every other iteration's — **provided** the evaluation-cap
  check that currently short-circuits the loop early (lines 624-634,
  `consumedAtDepth >= placementEvaluationQuotaPerDepth ||
  consumedPlacementEvaluations >= placementEvaluationCap`) is evaluated
  *before* dispatching parallel work, not interleaved with it, since that
  check's serial semantics (stop consuming budget at exactly candidate N)
  must be preserved: the ordinal-position-based decision of *which*
  candidates get scored at all is chronology-sensitive even though the
  scoring of each *admitted* candidate is not (see §14.2 for why this must
  stay serial in its outer shape).
- **`irregularLayoutScorer.ts`'s pure numeric helpers**
  (`deriveFreeMaterialMetrics`, `polygonArea`, `polygonPerimeter`,
  `absolutePolygonArea`, `convexHull`, `deriveRawOccupiedHullWasteRatio`):
  each operates on one already-materialized state/snapshot with no shared
  mutable state — safe to compute off the main thread, but since
  `scoreState` is called at most once per job in production (§9.2), there
  is no meaningful parallel workload here to extract for the default
  Compact/Compact Short Side path specifically; this matters more if the
  Rust port also has to serve the dead-for-production `windowedBeam.ts`-style
  beam search under non-default settings (§15).
- **`IrregularBeamState.withPlacement`'s internal phases** (canonical-entry-key
  insertion, spatial-index add, contact measurement) are each pure
  transforms of the *same* input state and *do not* have cross-phase shared
  mutable state within one call — but they are cheap relative to
  synchronization overhead for realistic piece counts (tens to low hundreds
  of placed pieces per state), and more importantly the **contact
  measurement phase's correctness depends on reading `this.placedCollisionIndex`,
  the pre-add index** (line 206, passed as `this.placedCollisionIndex`,
  *before* the local `placedCollisionIndex` variable that includes the new
  entry) — any parallel restructuring must preserve this "measure against
  the old index, not the new one" ordering exactly (§4.1 step 4).

### 13.2 Chronology-bound / must-stay-serial

- **`deriveSharedCollisionBoundaryMetrics`'s nested summation order**
  (§7.4) — floating-point addition is not associative; parallel/tree-reduction
  summation of the same terms in a different grouping can produce a
  different last-bit result than the current strictly-sequential
  left-to-right double loop. If this sum must remain bit-identical to the
  TS baseline (required, since it feeds externally-visible score output and
  contributes to the "sticky undefined" state-machine property, §4.3), **do
  not parallelize this reduction** — or if parallelized for performance,
  use a fixed, deterministic, TS-order-preserving reduction tree and add a
  differential test proving bit-identical results across thread counts
  (per migration prompt §14.4's "exact parity at thread counts 1, 2, and
  representative higher counts").
- **`insertCanonicalEntryKey`'s incremental linear-scan insertion**
  (irregularBeamState.ts:873-888) is inherently sequential (each insertion
  depends on the array state left by the previous insertion) within one
  `.withPlacement` chain — this is fine, since it operates on one state's
  history, not across parallel branches, but a Rust port must not try to
  parallelize insertions *within* a single beam-state lineage.
- **The free-material cache's parent-lookup fast path**
  (`computeSnapshotWithParentFallback`, §9.1) depends on the *parent
  state's* `scoreState` having already run and published to the cache
  *earlier in wall-clock/logical time* — if `scoreState` calls for sibling
  or unrelated states are ever parallelized (not currently the case in
  production, since it's called once per job), the cache becomes a shared
  mutable structure whose *hit/miss outcome* depends on race timing. Per
  the migration prompt §13.1 ("cache insertion race order never changes
  output"), this is only safe to parallelize if a cache miss always falls
  back correctly to `full()` with an **identical result** to what
  `extendFreeMaterial` would have produced (an assumption this cluster
  cannot verify — see §9.1/§15) — if that equivalence does not hold
  exactly, then which lane wins the race could change the *value*, not
  just the timing, which would violate the migration prompt's hard
  determinism requirement. Recommend: keep this cache access serial in the
  Rust port until the `computeFreeMaterial`/`extendFreeMaterial` equivalence
  is proven by the geometry/caches cluster's characterization and a
  dedicated differential test.
- **`IrregularBeamState.withPlacement`'s dependency on `this` (parent
  state)**: every derived field extension (`extendCollisionBounds`,
  `extendSharedCollisionBoundaryMetrics`, `insertCanonicalEntryKey`) reads
  the *exact* parent state's fields, not a recomputed/parallel-safe
  snapshot — this is simply how immutable functional state transitions
  work and is not itself a parallelism hazard (each transition is a pure
  function of one parent + one new placement), but it means **the beam
  search's tree of states cannot have its individual `.withPlacement` calls
  reordered relative to their true parent-child dependency** — i.e. you
  cannot compute a grandchild state without first computing its parent.
  Independent *sibling* branches (different candidates applied to the same
  parent state) **are** parallel-safe with respect to each other (each
  reads the same immutable parent, writes nothing shared) — this is the
  "independent candidate legality or score evaluation" pattern from §14.1
  applied at the state-transition level, not just the scoring level, and is
  the most promising Rayon target in this cluster: **fan out `.withPlacement`
  + local candidate scoring across sibling candidates of one parent state in
  parallel, then reduce by the exact TS comparator/tie rules serially** —
  exactly the migration prompt §14.3 deterministic pattern. The actual
  comparator used for that serial reduction on the production path is
  `intrinsicStrictDecoder.ts`'s or `intrinsicCapacitySearch.ts`'s own local
  comparator (out of this cluster), not anything in
  `irregularPlacementScorer.ts`/`irregularLayoutScorer.ts` (§1.2) — so the
  parallel-fan-out-then-serial-reduce boundary should be designed jointly
  with those files' characterization, using this cluster's state-construction
  primitives as the parallel unit of work.

---

## 14. Tests and gates covering this cluster

Direct unit tests (Grep of `tests/` and `scripts/` for imports of this
cluster's five files):

- `tests/unit/algorithm.test.ts` — `describe('sortPiecesForNesting', ...)`
  (lines 107-117): only two cases — pass-through of equal-priority pieces
  in original order, and empty-array input. **Does not test the actual
  descending longestEdge/area/imbalance ordering logic or any tie-break
  scenario with genuinely differing values** — a real coverage gap for the
  user-owned boundary function (§2.1, §15).
- `tests/unit/irregularPlacementScorer.test.ts` (469 lines, `describe('IrregularPlacementScorer', ...)`
  at line 159): 16 `it` blocks covering the balanced/short-side-fill/edge-contact
  policies, square-sheet override, translation-equivalent ties, exact
  transform/pieceId tie-break resolution, typed-error path for mismatched
  candidate metadata, and grid canonicalization of translated scores. This
  is the primary differential-test source for `irregularPlacementScorer.ts`'s
  comparator chains (§6.1), even though those chains are dead for
  production Compact/Compact Short Side (§1) — worth keeping/porting as-is
  since it's the authoritative spec for the comparator behavior regardless
  of current reachability.
- `tests/unit/irregularLayoutScorer.test.ts` (1156 lines, `describe('IrregularLayoutScorer',
  ...)` at line 223): the largest test file in this cluster by far —
  31 `it` blocks covering translation-invariant anchoring, unplaced-count
  dominance, compaction-vs-free-material tie order, structural-contact
  band transitions at the `STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT` (20)
  boundary, exact-tie determinism via `placementOrder`/`unplacedSourcePieceIds`,
  the free-material cache's hit/reuse/extend/fallback behavior explicitly
  (lines 841-995: "reuses free material for identical geometry," "extends a
  cached parent snapshot," "falls back to full material computation when
  incremental extension fails," "does not reuse free material after
  geometry or sheet inputs change"), and canonical-key/grid-identity
  equivalence for `IrregularBeamState` (lines 996-1155, overlapping with
  `canonicalCollisionPolygonKeyEquivalence.test.ts` below). This file is
  effectively the authoritative behavioral spec for §9.1's cache sequence.
- `tests/unit/canonicalCollisionPolygonKeyEquivalence.test.ts` (237 lines,
  `describe('canonicalCollisionPolygonKey', ...)` at line 168): dedicated
  property-style tests for §5.4/§8.1's ring-origin/winding normalization —
  the primary source of truth for exact canonical-key equivalence classes
  (translation, rotation-of-start-vertex, winding reversal).
- `tests/unit/irregularWorkerCompute.test.ts`, `irregularBeamDecoder.test.ts`,
  `irregularPortfolio.test.ts`, `irregularWindowedBeam.test.ts`,
  `irregularBenchmark.test.ts`, `algorithm.test.ts` (broader parts),
  `irregularTriangleCompactGolden.test.ts`,
  `irregularSeventeenShapesCompactGolden.test.ts`,
  `intrinsicSharedArchivePortfolio.test.ts`, `intrinsicStrictDecoder.test.ts`,
  `intrinsicCapacityIntegration.test.ts`, `intrinsicCapacityMode.test.ts`,
  `intrinsicGlobalSqueezePortfolio.test.ts`, `intrinsicSqueezeDisruptSeparate.test.ts`
  — exercise this cluster **indirectly** through the production/experimental
  search pipelines that consume `IrregularBeamState` and (for the golden/
  archive/capacity tests) the live `IrregularPlacementScorer.Make.scoreCandidate`
  and `IrregularLayoutScorer.scoreState` call sites identified in §1.2.
  These are the tests most likely to catch a regression in
  `sharedCollisionBoundaryLengthMm` computation or canonical-key format,
  since they assert on end-to-end placed-piece counts, hashes, and scores.

Scripts (not tests, but developer-invoked gates/probes referencing this
cluster transitively through the search pipeline, not directly):
`scripts/irregular-benchmark.ts`, `scripts/irregular-capacity-gate.ts`,
`scripts/irregular-compact-baseline.ts`, `scripts/irregular-sheet-invariance.ts`,
and others under `scripts/irregular-*` — none import this cluster's files
directly (Grep confirms only `import`-level matches, all through the
production entry points).

**Coverage gap identified**: no dedicated `irregularScoreGrid.test.ts` file
exists. `canonicalizeIrregularScoreMillimeters`/`canonicalizeIrregularScoreMillimeterUnits`/
`canonicalizeIrregularScoreScalar`'s exact rounding rule (§7.1, including
the round-half-away-from-zero tie behavior, the `-0`/`Math.sign` interaction,
and the `Number.isSafeInteger` overflow boundary) is exercised only
*incidentally* through `irregularPlacementScorer.test.ts`/`irregularLayoutScorer.test.ts`'s
assertions on downstream scores, never directly at the grid-rounding
function boundary with adversarial inputs (values exactly on a `0.0005 mm`
half-way boundary, values just inside/outside `Number.MAX_SAFE_INTEGER /
1000`, `-0` input). Per the migration prompt §18.2 ("Rust unit tests" must
cover "canonical-grid rounding," "signed zero," "NaN and infinity
rejection"), this gap should be closed with **new** TS characterization
tests (not modifying existing ones) before or alongside the Rust port, so
the Rust differential tests have a byte-exact TS oracle to compare against
at the function boundary, not just at the end-to-end score boundary.

No test file directly targets `sortPiecesForNesting`'s actual sort-key
ordering effect (only pass-through/empty-array cases, per above) — the same
new-test recommendation applies.

---

## 15. Open questions and ambiguities

1. **Scope question, potentially load-bearing for the whole port: does the
   Rust port need to reproduce `IrregularPlacementScorer`'s and
   `IrregularLayoutScorer`'s comparator chains (`compareScores`,
   `balancedCompactnessOrder`, `shortSideFillOrder`,
   `edgeContactThenBalancedCompactnessOrder`, `intrinsicCompactnessOrder`,
   `layoutScoreOrder`, `strictLayoutScoreOrder`, `scaleAwareLayoutScoreOrder`)
   at all, given that none of them are reachable on the production
   Compact/Compact Short Side path under default settings (§1)?** The
   migration prompt's scope is explicitly the two named production profiles,
   and its "Definition of done" (§25) talks about "Compact runs fully in
   Rust" / "Compact Short Side runs fully in Rust" — not "every schema-legal
   settings combination runs fully in Rust." But the same prompt also says
   the TypeScript reference stays available as a "differential oracle,
   fallback, and rollback path" (§1) and that "Do not stop after porting...
   another subset" (§1) — suggesting eventual full coverage is expected.
   **Recommend the orchestrator explicitly rule**: (a) port these
   comparators as part of Stage 2 regardless, treating them as reachable
   "dead code" that must still be exact because a settings change or a
   differential/test harness could reach them; or (b) explicitly descope
   `windowedBeam.ts`/`portfolioSearch.ts` and everything reachable only
   through them from the Rust port's Stage 2 "complete one-thread parity"
   requirement, keeping that whole subtree TypeScript-only even after Rust
   promotion (a scope carve-out the prompt does not currently state
   explicitly for this specific subtree). Either choice is legitimate, but
   it changes how much of `irregularPlacementScorer.ts`/`irregularLayoutScorer.ts`
   needs a Rust equivalent at all, so it should be settled before Stage 2
   estimation.

2. **`contactSignatureContinuationIdentity()`'s `JSON.stringify(undefined)`
   return value** (§8.3, §12 item 4) needs an empirical Node.js repro before
   porting: does it return the JS `undefined` value (contradicting its
   declared `string` return type) or the string `"undefined"`? This affects
   `continuationMetadataIdentity()`'s (149-156) outer `JSON.stringify`
   result whenever `nearCompleteStructuralContactSignatureCounts` is
   `undefined` (i.e. whenever the shared-boundary metrics themselves are
   `undefined`, the "sticky undefined" case, §4.3). Also needs tracing
   forward: is `continuationMetadataIdentity()` actually read by any
   **production** caller? This cluster's Grep found no production caller
   within these five files' direct consumers; it may be read by the
   checkpoint/resumable-search cluster (out of scope here) — flag for that
   cluster's characterization to confirm or refute.

3. **The `deriveSharedCollisionBoundaryMetrics` (full, unpruned pairwise
   loop) vs. `extendSharedCollisionBoundaryMetrics` (spatial-index-pruned
   incremental loop) bit-exact equivalence claim (§7.4) is inferred, not
   proven, within this cluster's files.** It depends on
   `measureSharedConvexPolygonBoundaryContact` (in
   `convexPolygonContact.ts`, a different cluster) returning a literal exact
   `0.0` — not a small nonzero epsilon — for every pair of collision
   polygons whose axis-aligned bounding boxes are disjoint. Recommend: (a)
   the geometry cluster's characterization confirm this from
   `convexPolygonContact.ts`'s actual implementation, and (b) a new
   differential test in this repository assert
   `deriveSharedCollisionBoundaryMetrics(geometries)` (invoked via a fresh
   `new IrregularBeamState({...placedCollisionGeometries: geometries})`)
   produces bit-identical `sharedCollisionBoundaryLengthMm`/
   `sharedCollisionBoundaryContactUnits`/`nearCompleteStructuralContactCount`
   to the same geometries built via a chain of `.withPlacement` calls, for a
   representative range of piece counts and spatial layouts (including
   layouts with disjoint and overlapping bounding boxes deliberately
   mixed). Without this, a Rust port that unifies the two loops (a natural
   simplification instinct) risks a silent floating-point divergence that
   would only surface as an unexplained hash/score mismatch far downstream.

4. **The free-material cache's `extendFreeMaterial` vs. `computeFreeMaterial`
   numeric equivalence (§9.1, §13.2)** is likewise assumed, not proven,
   within this cluster — `freeMaterialService.ts` (a different cluster)
   owns both implementations. Given `scoreState` runs once per production
   job (§9.2), this specific equivalence is **not exercised by the
   parent-fallback path in default production Compact/Compact Short Side
   runs at all** (no second `scoreState` call exists to trigger it) — but it
   *is* exercised whenever `windowedBeam.ts` runs (dead for production,
   live for non-default settings and for `irregularLayoutScorer.test.ts`'s
   own direct tests, e.g. lines 870-995). Recommend confirming with the
   geometry/caches cluster whether `extendFreeMaterial` is proven
   numerically identical to `computeFreeMaterial` for a matching state, or
   whether it is merely "close" (in which case the current TS behavior
   itself has an unavoidable path-dependent free-material metric, which
   the Rust port must reproduce exactly including the path-dependence, not
   "fix").

5. **`compareScores`'s policy-dispatch asymmetry** (§6.1): `compareScores`
   (irregularPlacementScorer.ts:283-297) is not obviously guaranteed
   antisymmetric (`compare(a,b) === -compare(b,a)`) when `a.policyId !==
   b.policyId`, because the dispatch condition checks `first.policyId`
   against a constant rather than checking "either side matches." In
   current production usage every compared pair shares one job's single
   configured `policyId`, so this is unobservable today, but if the Rust
   port's differential harness ever compares scores with mixed policies
   (e.g. a fuzz/property test per migration prompt §18.5), it may need to
   special-case this rather than assume a well-behaved total order. Flag
   for the orchestrator to decide whether to preserve the asymmetry
   byte-exact (required by the "preserve comparison signs" rule, migration
   prompt §2) or treat it as unreachable and therefore irrelevant.

6. **`collisionBoundsBottomMm`/`collisionBoundsLeftMm`'s only other consumer,
   `decisionTrace.ts:170-171,189-190,209-210`** (§3.4), belongs to the
   trace/replay cluster. This document cannot confirm whether that
   consumer is itself live on the production path or reads these fields
   from a different, non-`IrregularLayoutScore` source. Flag for the
   trace-cluster characterization to confirm.

7. **`RectWith` schema** (`src/shared/domain/geometry.ts:36-49`) guarantees
   `longestEdge`/`area`/`imbalance` are exact integers for
   `sortPiecesForNesting`'s comparator (§3.1, §7 — no float-tie concerns).
   This document did not verify whether `IrregularPreparedPiece.priorityOrderKey`
   (`src/shared/irregular/domain.ts:476-490`, built from the *same* padded
   bounds at `computeIrregularNesting.ts:423-427`) is ever compared with a
   **different** numeric type (e.g. as `number` generically, losing the
   schema-level integer guarantee) by a downstream consumer in another
   cluster (e.g. `priorityOrderService.ts`) — if such a consumer exists and
   treats these as arbitrary floats, the "integers only" simplification
   this document relies on for §7's "no epsilon needed" claim would need
   re-verification there, not here.

8. **Duplicate cross-cluster canonicalization systems** (§8.4): this
   document explicitly disambiguates `IrregularBeamState`'s
   `canonicalOccupiedGeometryKey` (float-grid vertex-coordinate string,
   this cluster) from the SHA-256 `canonicalGeometryHash`/
   `sheetlessCanonicalGeometryHash` system (Clipper2 integer geometry,
   different cluster) referenced throughout `computeIrregularNesting.ts`.
   Recommend the geometry/hashing cluster's characterization state this
   same disambiguation explicitly from its side, so no reader assumes the
   two systems are the same key space or that one can substitute for the
   other.

9. **Governance conflict risk**: `sortPiecesForNesting.ts` is marked
   "user-owned" (`AGENTS.md:46`) — a repository rule independent of and
   stricter in spirit than the migration prompt's general
   semantics-preservation mandate (it forbids even *approved* algorithm
   improvements to this specific function without an explicit user request,
   whereas the migration prompt's non-negotiable objective already forbids
   behavior changes but is framed around the port as a whole). No conflict
   currently, since porting this function verbatim satisfies both rules
   simultaneously — flagged only so the orchestrator does not accidentally
   authorize a "small cleanup" here under the general port mandate without
   realizing this file carries an extra, repository-specific restriction.
