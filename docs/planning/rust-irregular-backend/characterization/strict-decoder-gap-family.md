# Characterization: strict-decoder-gap-family cluster

Cluster files (read completely, line-cited below):

- `src/workers/algorithm/irregular/intrinsicStrictDecoder.ts` (2363 lines)
- `src/workers/algorithm/irregular/intrinsicGapRegions.ts` (238 lines)
- `src/workers/algorithm/irregular/intrinsicStrictFamilyPortfolio.ts` (536 lines)

This document is a port specification, not a summary. Every nontrivial claim is
anchored to a `file:line`. Where TypeScript behavior looks unusual, that is
intentional per the governing prompt
(`docs/history/prompts/fable5-rust-irregular-nesting-implementation.md` §2): the
existing behavior is the spec.

---

## 1. Purpose and role in Compact / Compact Short Side execution

### 1.1 What each file does

- **`intrinsicStrictDecoder.ts`** implements "E1": one deterministic,
  sheet-independent ("sheetless") constructive placement pass over an ordered
  piece list, followed by terminal q0/q90 real-sheet legality
  (`decodeIntrinsicStrictPriorityOrder`, `src/workers/algorithm/irregular/intrinsicStrictDecoder.ts:331-363`).
  It also owns: the local per-candidate scoring model
  (`IntrinsicStrictLocalScore`, `intrinsicStrictDecoder.ts:80-91`), transform-family
  best-of selection, gap-contained candidate selection, completed-layout metric
  measurement, the cohesion "certificate" (floor violations +
  exact relative-deficit fraction), Pareto-dominance comparison and ranking of
  completed layouts, and a resumable direct checkpoint format
  (`IntrinsicStrictDirectCheckpoint`, `intrinsicStrictDecoder.ts:185-197`).
- **`intrinsicGapRegions.ts`** derives the exact canonical "gap regions" of a
  partial layout — the convex-hull-minus-occupied-union solids, split into
  `enclosed-cavity` vs `hull-open-gap` kinds
  (`deriveCanonicalIntrinsicGapRegions`, `intrinsicGapRegions.ts:42-72`) — and
  tests whether a candidate placement is fully contained in one such region
  with zero positive leftover area (`candidateContainedInIntrinsicGap`,
  `intrinsicGapRegions.ts:75-106`). It is a pure Clipper2-backed geometry
  helper consumed only by the strict decoder.
- **`intrinsicStrictFamilyPortfolio.ts`** defines "collision family" grouping
  (pieces that are declared-interchangeable *and* have identical collision
  polygon shape, `intrinsicCollisionFamilyKey`,
  `intrinsicStrictFamilyPortfolio.ts:124-130`), plus a four-order ×
  two-template chromosome portfolio (`baseline` /
  `family-round-robin` / `size-band-family-interleave` /
  `large-first-small-fill` × `coaxial` / `crossed`,
  `intrinsicStrictFamilyPortfolio.ts:26-39`) that runs the E1 decoder per
  chromosome and ranks the results.

### 1.2 Liveness on the production Compact / Compact Short Side path (traced, not assumed)

**Live (reachable from `computeIrregularNesting.ts`, which `nesting.worker.ts`
calls at `src/workers/nesting.worker.ts:377`):**

- `intrinsicStrictDecoder.ts` — **entirely live**. Traced call chain:
  `computeIrregularNesting.ts` imports from `intrinsicSharedArchivePortfolio.ts`
  (`computeIrregularNesting.ts:56`) → `intrinsicSharedArchivePortfolio.ts`
  imports `constructIntrinsicStrictState`, `evaluateIntrinsicStrictCertificate`,
  `measureIntrinsicSheetlessCompletedLayout`, `rankIntrinsicStrictCompletedLayouts`,
  `selectIntrinsicStrictCompletedParetoFront`
  (`intrinsicSharedArchivePortfolio.ts:24-34`) and calls
  `constructIntrinsicStrictState({...})` directly at
  `intrinsicSharedArchivePortfolio.ts:277` for three **direct producer roles**
  — `'canonical-grid'`, `'legacy-absolute-envelope'`, `'open-pocket-first'`
  (`INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES`,
  `intrinsicSharedArchivePortfolio.ts:41-45`). `evaluateIntrinsicStrictCertificate`'s
  output is not merely diagnostic: `compareCertificateDeficit`, which reads
  `certificate.relativeDeficitSum` / `exactRelativeDeficitNumerator` /
  `exactRelativeDeficitDenominator`, is the **first** tiebreaker in the
  production archive-winner comparator `compareIntrinsicSharedArchiveWinner`
  (`intrinsicSharedArchivePortfolio.ts:407-449`), applied after Pareto-front
  filtering. `constructIntrinsicStrictState` is also called from
  `intrinsicReconstructionPortfolio.ts:222` (imported by
  `computeIrregularNesting.ts:60`) and from `intrinsicPeriodicFamilyPortfolio.ts:317`
  (imported transitively via `intrinsicSharedArchivePortfolio.ts:23`).
- `intrinsicGapRegions.ts` — **live**, exclusively through
  `intrinsicStrictDecoder.ts`, which imports both of its exports
  (`intrinsicStrictDecoder.ts:41-44`) and calls
  `deriveCanonicalIntrinsicGapRegions` per piece whenever `candidateMode` is
  the object form `{ kind: 'gap-contained' }` or an F0 observer is attached
  (`intrinsicStrictDecoder.ts:566-569`), and calls
  `candidateContainedInIntrinsicGap` per scored candidate whenever
  `gapRegions` is defined (`intrinsicStrictDecoder.ts:1465-1467`). The
  `'open-pocket-first'` direct role always uses `{ kind: 'gap-contained' }`
  (`directCandidateMode`, `intrinsicSharedArchivePortfolio.ts:554-558`), and
  `intrinsicReconstructionPortfolio.ts` also uses `{ kind: 'gap-contained' }`
  for several of its roles (`intrinsicReconstructionPortfolio.ts:309,328,334`).
  So gap-region derivation and containment testing execute on every production
  Compact job, not just in a probe.
- `intrinsicStrictFamilyPortfolio.ts` — **only `groupIntrinsicCollisionFamilies`
  (and the `IntrinsicCollisionFamily` type) are live.** They are imported by
  `intrinsicPeriodicCells.ts:44-46` (used at `intrinsicPeriodicCells.ts:288-296`
  to rank families by member count/area for the periodic P1/P2 catalog) and by
  `intrinsicPeriodicFamilyPortfolio.ts:40` (used at
  `intrinsicPeriodicFamilyPortfolio.ts:643-644,1079-1081`).
  `intrinsicPeriodicFamilyPortfolio.ts` is in turn imported and called by
  `intrinsicSharedArchivePortfolio.ts:17-22,192` (`runIntrinsicPeriodicFamilyPortfolio`),
  which is on the traced production path above. So `groupIntrinsicCollisionFamilies`
  runs on every production Compact job that reaches the periodic-family stage.

**NOT live in production (experimental / probe-only — see §15 for the
discrepancy this creates against the migration prompt's file list):**

- Every other export of `intrinsicStrictFamilyPortfolio.ts` —
  `buildIntrinsicFamilyPortfolioChromosomes`, `runIntrinsicStrictFamilyPortfolio`,
  `selectIntrinsicFamilyPortfolioWinner`, `orderIntrinsicFamilyPortfolioPieces`,
  `selectRepeatedElongatedFamilies`, `sizeBands`, `familyRoundRobin`,
  `restrictOrientationTemplate`. Grep of `src/` and `scripts/` (excluding this
  file and tests) shows zero importers of `runIntrinsicStrictFamilyPortfolio`,
  `buildIntrinsicFamilyPortfolioChromosomes`, `selectIntrinsicFamilyPortfolioWinner`,
  or `selectRepeatedElongatedFamilies` outside `intrinsicStrictFamilyPortfolio.ts`
  itself, `tests/unit/intrinsicStrictFamilyPortfolio.test.ts`, and
  `scripts/irregular-intrinsic-family-portfolio-probe.ts` /
  `scripts/irregular-intrinsic-shared-archive.ts` (developer probe scripts, not
  wired into any `pnpm` script in `package.json` — confirmed by grepping
  `package.json` for each script's basename with zero hits). `orderIntrinsicFamilyPortfolioPieces`
  has one non-test caller, `scripts/irregular-intrinsic-shared-archive.ts:185`,
  also a probe script.
- `intrinsicGlobalSqueezePortfolio.ts`, `intrinsicV7SeedArchive.ts`,
  `intrinsicQueueBeamDiscriminator.ts`, `intrinsicPeriodicSmallFillE3.ts` — all
  call into `constructIntrinsicStrictState`/`finalizeIntrinsicStrictState`
  (making them consumers of the live decoder API), but none of them has *any*
  importer inside `src/` (grep confirms zero). They are exercised only by
  `scripts/*` probes and `tests/unit/*`. They do not affect this cluster's
  production liveness, but a Rust port must not assume every caller of
  `constructIntrinsicStrictState` visible in `src/` is production-reachable —
  each caller must be traced individually, exactly as done above.
- `intrinsicPlaceDeferCompleteShadow.ts` is imported by
  `computeIrregularNesting.ts:92`, but its name and the migration prompt's own
  vocabulary ("shadow-only modules remain non-authoritative", prompt §10 item 11)
  indicate it is an observer; it does not call into this cluster
  (`grep` shows no `constructIntrinsicStrictState`/gap-region import inside it — see
  earlier trace) and is out of this cluster's scope regardless.

### 1.3 Net characterization for a Rust implementer

Port the **entire contents** of `intrinsicStrictDecoder.ts` and
`intrinsicGapRegions.ts` — everything in both files is reachable from
production Compact and (transitively, since Short Side receives Compact's
settled partition per prompt §12) Compact Short Side. For
`intrinsicStrictFamilyPortfolio.ts`, the Rust port's *production* obligation is
narrower: `groupIntrinsicCollisionFamilies`, `intrinsicCollisionFamilyKey`,
`measureCollisionPolygon`, `canonicalCyclicPolygonKey`, and `cyclicKeys`
(§2.3). The remaining ~80% of the file (chromosome portfolio machinery) is
part of the maintained TypeScript reference backend per prompt §4.1 but is not
on the Compact/Compact Short Side execution path today; see §15 for the
explicit question this raises for the orchestrator.

---

## 2. Entry points, callers, callees (traced)

### 2.1 `intrinsicStrictDecoder.ts` — public surface and callers

| Export | Definition | Production callers (file:line) |
| --- | --- | --- |
| `decodeIntrinsicStrictPriorityOrder` | `intrinsicStrictDecoder.ts:331-363` | None in `src/` (only `intrinsicStrictFamilyPortfolio.ts:296`, itself dead in prod, and `scripts/irregular-intrinsic-strict-probe.ts:71`). This is the "full" entry point (construct + finalize) but production code calls the two halves separately. |
| `finalizeIntrinsicStrictState` | `intrinsicStrictDecoder.ts:366-398` | `intrinsicPeriodicFamilyPortfolio.ts:382`, `intrinsicPeriodicSmallFillE3.ts:194` (dead), `intrinsicQueueBeamDiscriminator.ts:1353,2055` (dead) |
| `constructIntrinsicStrictState` | `intrinsicStrictDecoder.ts:401-866` | `intrinsicSharedArchivePortfolio.ts:277`, `intrinsicReconstructionPortfolio.ts:222`, `intrinsicPeriodicFamilyPortfolio.ts:317`, plus dead callers in `intrinsicV7SeedArchive.ts`, `intrinsicGlobalSqueezePortfolio.ts`, `intrinsicPeriodicSmallFillE3.ts`, `intrinsicPlaceDeferCompleteShadow.ts` |
| `measureIntrinsicSheetlessCompletedLayout` | `intrinsicStrictDecoder.ts:1823-1852` | `intrinsicSharedArchivePortfolio.ts:625`, `intrinsicReconstructionPortfolio.ts:266`, plus dead callers |
| `evaluateIntrinsicStrictCertificate` | `intrinsicStrictDecoder.ts:1956-2018` | `intrinsicSharedArchivePortfolio.ts:634` (feeds `compareCertificateDeficit`), plus dead caller in `intrinsicGlobalSqueezePortfolio.ts` |
| `rankIntrinsicStrictCompletedLayouts` | `intrinsicStrictDecoder.ts:2284-2288` | `intrinsicSharedArchivePortfolio.ts:371`, `intrinsicReconstructionPortfolio.ts:506`, `intrinsicPeriodicFamilyPortfolio.ts:394`, plus dead caller in `intrinsicQueueBeamDiscriminator.ts` |
| `selectIntrinsicStrictCompletedParetoFront` | `intrinsicStrictDecoder.ts:2271-2281` | `intrinsicSharedArchivePortfolio.ts:396`, `intrinsicReconstructionPortfolio.ts:445` |
| `intrinsicStrictCompletedLayoutDominates` / `compareIntrinsicStrictCompletedLayoutDominance` | `intrinsicStrictDecoder.ts:2263-2268`, `:2248-2261` | `intrinsicShortSideObserver.ts:181` (observer-only, prompt §10 item 11 — non-authoritative unless production semantics explicitly admit its result), `intrinsicQueueBeamDiscriminator.ts` (dead) |
| `selectIntrinsicStrictFamilyWinner` | `intrinsicStrictDecoder.ts:1563-1609` | called internally at `intrinsicStrictDecoder.ts:715,1545`; external dead caller in `intrinsicQueueBeamDiscriminator.ts:3142` |
| `measureIntrinsicStrictCanonicalEnvelope` | `intrinsicStrictDecoder.ts:315-328` | not called anywhere in `src/` outside its own file (grep: only the test file) — dead export retained for external test/probe use |
| `canonicalLinearMetric` / `canonicalAreaMetric` | `intrinsicStrictDecoder.ts:1692-1699` | used internally throughout this file's comparators; not imported elsewhere in `src/` |
| `INTRINSIC_STRICT_COHESION_FLOORS`, `INTRINSIC_STRICT_DIRECT_CHECKPOINT_VERSION`, `INTRINSIC_STRICT_PHASE_INSTRUMENTATION_ALLOWANCE_MS`, `INTRINSIC_STRICT_PHASE_MAXIMUM_RELAXED_RESIDUAL_RATIO`, `intrinsicStrictPhaseCoverageComplete`, `originAnchorCandidates`, `INTRINSIC_COORDINATE_DOMAIN`, `transformCandidateOrder` | various | internal use plus test imports; `INTRINSIC_COORDINATE_DOMAIN` is the 1×1mm placeholder sheet used for sheetless candidate generation (`intrinsicStrictDecoder.ts:595`) |

### 2.2 `intrinsicGapRegions.ts` — public surface and callers

| Export | Definition | Callers |
| --- | --- | --- |
| `deriveCanonicalIntrinsicGapRegions` | `intrinsicGapRegions.ts:42-72` | `intrinsicStrictDecoder.ts:568` (per piece, conditionally), `:760` (recomputed after a gap-fill placement, for evidence bookkeeping); dead caller `intrinsicQueueBeamDiscriminator.ts` |
| `candidateContainedInIntrinsicGap` | `intrinsicGapRegions.ts:75-106` | `intrinsicStrictDecoder.ts:1467` (per scored candidate, when `gapRegions` defined) |

Internal-only helpers (`collectRegions`, `pathTouchesBoundary`, `placedPath`,
`totalPositiveDoubledArea`, `pathBounds`, `canonicalRing`) are not exported
and have no other callers by construction.

### 2.3 `intrinsicStrictFamilyPortfolio.ts` — public surface and callers

| Export | Definition | Production caller(s) | Live? |
| --- | --- | --- | --- |
| `groupIntrinsicCollisionFamilies` | `intrinsicStrictFamilyPortfolio.ts:95-121` | `intrinsicPeriodicCells.ts:288`, `intrinsicPeriodicFamilyPortfolio.ts:644,1080` | **Yes** |
| `intrinsicCollisionFamilyKey` | `intrinsicStrictFamilyPortfolio.ts:124-130` | called internally by `groupIntrinsicCollisionFamilies` (`:100`) and `restrictOrientationTemplate` (`:390`, dead path) | **Yes** (via the live caller) |
| `IntrinsicCollisionFamily` (type) | `intrinsicStrictFamilyPortfolio.ts:41-48` | `intrinsicPeriodicCells.ts:45`, `intrinsicPeriodicFamilyPortfolio.ts` | **Yes** |
| `orderIntrinsicFamilyPortfolioPieces`, `sizeBands`, `selectRepeatedElongatedFamilies`, `buildIntrinsicFamilyPortfolioChromosomes`, `runIntrinsicStrictFamilyPortfolio`, `selectIntrinsicFamilyPortfolioWinner` | various, see §1.2 | none in `src/` outside this file | **No** |

Internal helpers `familyRoundRobin` (`:347-362`), `restrictOrientationTemplate`
(`:364-422`), `matchesPhysicalLongAxis` (`:424-431`), `chromosomeIdentity`
(`:433-447`), `normalizeRotationDeg` (`:449-453`) belong to the dead
chromosome-portfolio path. `measureCollisionPolygon` (`:469-512`) and
`canonicalCyclicPolygonKey` (`:514-528`) / `cyclicKeys` (`:530-536`) are live
because `groupIntrinsicCollisionFamilies` and `intrinsicCollisionFamilyKey`
depend on them.

### 2.4 Callees outside the cluster (external services touched)

Traced, not guessed, by reading the exact call sites:

- `GeometryKernel.transformCollisionGeometry` — `intrinsicStrictDecoder.ts:585-588`
  (moving-geometry transform, once per piece × transform),
  `intrinsicStrictFamilyPortfolio.ts:397-400` (dead path, orientation template).
- `NfpIfpService.generatePlacementCandidates` — `intrinsicStrictDecoder.ts:594-610`,
  called once per (piece, transform) after the first placement; receives
  `state.placedCollisionIndex` (read-only), a per-decode `candidateMemoScope`
  (`IrregularNfpIfpCandidateMemoScope`, created once at `intrinsicStrictDecoder.ts:471`
  and reused for every piece/transform in the same `constructIntrinsicStrictState`
  call, never across calls), and the cooperative `control` object.
- `IrregularBeamState` (`irregularBeamState.ts`) — the immutable placement-state
  class. Constructed at `intrinsicStrictDecoder.ts:491-495` (seed), and updated
  functionally via `withPlacement` (`:1421-1437`, inside `scoreCandidate`),
  `withUnplacedPiece` (`:801-806`), `withBottomLeftAnchored` (`:495,717,1443,1827,1946`),
  `withQuarterTurnBottomLeft` (`:1799`). These methods live in a different file/cluster
  and are treated here as an external, already-immutable dependency; see §4 for
  exactly which of this cluster's local variables they feed.
- `canonicalLayoutGeometry.ts` — `assertCanonicalGridLegalLayout`,
  `canonicalCollisionLayoutIdentity`, `measureCanonicalEnclosedCavities`,
  `measureCanonicalLayoutContacts`, `measureCanonicalLayoutEnvelope`,
  `measureCanonicalLayoutTopologyExact`, `analyzeCanonicalLayoutStructure` — all
  imported at `intrinsicStrictDecoder.ts:16-24` and used inside
  `completedMetrics` (`:1854-1934`), `finalizeIntrinsicStrictState`,
  `measureIntrinsicSheetlessCompletedLayout`, `selectTerminalOrientation`,
  and every legality assertion in the checkpoint-validation functions.
- `canonicalGridMath.ts` (via `intrinsicGapRegions.ts:16-24`) —
  `canonicalGridAbsoluteDoubledArea`, `canonicalGridClockwise`,
  `canonicalGridConvexHull`, `canonicalGridCounterClockwise`,
  `canonicalGridPointOnSegment`, `canonicalGridSignedDoubledArea`,
  `compareBigInts`, `doubledGridAreaToMm2`. Read in full at
  `src/workers/irregular/canonicalGridMath.ts:1-202`; see §7 for the exact
  arithmetic they perform.
- `clipper2-ts` (`intrinsicGapRegions.ts:1-9`) — `booleanOpWithPolyTree`,
  `ClipType`, `FillRule`, `PolyTree64`, `polyTreeToPaths64`. Pinned at
  `clipper2-ts@2.0.1-18` in `package.json:43`, matching
  `CLIPPER2_OFFSET_POLICY.backendVersion` (`src/workers/irregular/clipper2OffsetPolicy.ts:8`).
- `toGridMm` / `fromGrid` (`src/workers/irregular/clipper2OffsetPolicy.ts:44-58`) —
  the canonical grid quantization used pervasively by all three files; see §7.

---

## 3. Data in/out: exact types/shapes, optional-field presence/omission

### 3.1 `ConstructIntrinsicStrictStateInput` (`intrinsicStrictDecoder.ts:272-288`)

```
allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
frozenPlaced: ReadonlyArray<IrregularPlacedPiece>
candidateMode: IntrinsicStrictCandidateMode
maximumRuntimeMs?: number                       // default 120_000 (:417)
maximumCandidateEvaluationCount?: number         // clamped via Math.max(1, Math.floor(...)) (:418-421)
captureCandidateEvaluationCount?: boolean
capturePhaseTimings?: boolean
timingNow?: () => number                         // test-only deterministic clock seam
producerRole?: string                            // default 'intrinsic-strict' (:440)
checkpoint?: IntrinsicStrictDirectCheckpoint
maximumCompletedPieceBoundaries?: number         // clamped via Math.max(1, Math.floor(...)) (:422-425)
featureContactObserver?: IntrinsicStrictFeatureContactObserver
control?: IrregularNfpIfpControl
```

`IntrinsicStrictCandidateMode` (`intrinsicStrictDecoder.ts:93-101`) is either
one of the three string literals `'pure-growth' | 'legacy-absolute-envelope' |
'contact-band'` **or** the object literal `{ readonly kind: 'gap-contained' }`.
This is a discriminated union tested with `typeof input.candidateMode ===
'object'` (`:567,713,1577`), not a tag field — a Rust port must model this as
an enum with an explicit `GapContained` variant, not rely on structural
`typeof`.

### 3.2 `IntrinsicStrictConstructResult` (`intrinsicStrictDecoder.ts:170-180`)

```
state: IrregularBeamState
stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>
gapFillEvidence: ReadonlyArray<IntrinsicStrictGapFillEvidence>
candidateEvaluationCount?: number     // present iff captureCandidateEvaluationCount is true (:426-430,856-861)
truncationReason?: 'maximum-candidate-evaluations'   // present iff evaluation cap fired AND candidateEvaluationCount is being captured (:860)
pauseReason?: 'completed-piece-boundary'             // present iff paused for a completed-piece-boundary checkpoint (:854)
checkpoint?: IntrinsicStrictDirectCheckpoint         // present iff pauseReason==='completed-piece-boundary' AND fingerprinting enabled (:821-841,855)
phaseTimings?: IntrinsicStrictConstructPhaseTimings  // present iff capturePhaseTimings is true (:842-849,862)
runtimeMs: number
```

**Optional-field presence is produced with object-spread conditionals**
(`...(x === undefined ? {} : { x })`), not `field: undefined`. This is
semantically load-bearing: a key that is *omitted* differs from a key whose
value is JS `undefined` for anything downstream that does
`Object.prototype.hasOwnProperty` checks or that serializes with the
canonical JSON encoder (§8), which also treats "field present with value
`undefined`" as omitted (`intrinsicStrictDecoder.ts:1270`). A Rust port must
model these as `Option<T>` fields that are genuinely absent (e.g. skipped by
`serde(skip_serializing_if = "Option::is_none")`), not present-with-null.

### 3.3 `IntrinsicStrictDecodeResult` (`intrinsicStrictDecoder.ts:157-168`)

```
status: 'completed' | 'incomplete' | 'infeasible-final-sheet'
placements: ReadonlyArray<IrregularPlacement>
placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
unplacedPieceIds: ReadonlyArray<PieceId>
terminalRotationDeg: 0 | 90 | undefined
canonicalGeometryHash: string | undefined
metrics: IntrinsicStrictCompletedMetrics | undefined
certificate: IntrinsicStrictCertificate | undefined
stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>
runtimeMs: number
```

Note: unlike §3.2, these five "completed-only" fields (`terminalRotationDeg`
through `certificate`) are declared as always-present properties whose value
may literally be JS `undefined` (`makeResult`, `intrinsicStrictDecoder.ts:2345-2363`,
always sets all five to `undefined`; `finalizeIntrinsicStrictState`'s
`'completed'` branch overwrites them, `:391-397`). This is a genuine "key
present, value undefined" shape, distinct from §3.2's "key omitted" shape. A
Rust port should model this result as `Option<T>` fields that always
serialize (if ever serialized) rather than being skipped — but since this
struct is an internal search artifact (not itself hashed or persisted; see
§8), the distinction mainly matters for exact field-presence parity in
differential test harnesses, not for byte-identical hashes.

### 3.4 `IntrinsicStrictLocalScore` (`intrinsicStrictDecoder.ts:80-91`)

```
maximumSideMm: number
envelopeAreaMm2: number
envelopeSpanMm: number
sharedBoundaryLengthMm: number
canonicalCombinedGeometryKey: string
exact?: { maximumSideGrid: number; envelopeAreaGrid2: string; envelopeSpanGrid: number }
```

`exact.envelopeAreaGrid2` is a **decimal string encoding of a BigInt**
(`(BigInt(widthGrid) * BigInt(heightGrid)).toString()`,
`intrinsicStrictDecoder.ts:1521`), not a number — required because grid-area
products can exceed `Number.MAX_SAFE_INTEGER` well within maintained
production sheet sizes. `exact` itself is present iff
`measureIntrinsicStrictEnvelopeFromState` succeeds in producing finite grid
values (`:1500-1534`); it is **always** present when `translatedCollisionBounds`
is defined and grid-representable, i.e. in practice it is present for every
real candidate on the strict decoder's live paths. Comparators fork on
`exact !== undefined` (§6) to prefer exact BigInt arithmetic and fall back to
rounded-float comparison only when it is absent.

### 3.5 `IntrinsicStrictCompletedMetrics` (`intrinsicStrictDecoder.ts:108-140`)

Same "float projection + optional exact grid twin" pattern as §3.4, at larger
scale: 17 float/int fields plus one `exact` object with 10 fields, 6 of which
are BigInt-as-decimal-string doubled-area grid values
(`totalEnclosedCavityDoubledAreaGrid2`, `largestOccupiedHullGapDoubledAreaGrid2`,
`occupiedHullDoubledAreaGrid2`, `occupiedHullWasteDoubledAreaGrid2`,
`occupiedOutsideLargestContactComponentDoubledAreaGrid2`, plus
`envelopeAreaGrid2`). `completedMetrics` (`intrinsicStrictDecoder.ts:1854-1934`)
requires **every** field (`Object.entries(metrics).every(...)`, `:1925-1931`)
to be finite (numbers) or non-empty (strings) or defined (`exact`); if any
check fails the whole function returns `undefined` rather than a partially
populated object — there is no partial-metrics state.

### 3.6 `IntrinsicStrictDirectCheckpoint` (`intrinsicStrictDecoder.ts:185-197`)

```
version: 'intrinsic-strict-direct-checkpoint-v1'
producerRole: string
requestFingerprint: string        // sha256 hex
integrityHash: string             // sha256 hex
state: IrregularBeamState
nextPieceIndex: number
stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>
gapFillEvidence: ReadonlyArray<IntrinsicStrictGapFillEvidence>
candidateEvaluationCount: number
activeRuntimeMs: number
phaseLedger: IntrinsicStrictDirectPhaseLedger | undefined   // present iff capturePhaseTimings was true when produced
```

`phaseLedger` is stored as an actual `undefined`-valued key here (not
omitted), because the type is `T | undefined`, not `T?`, and the object
literal at `:896` always includes the key. The canonical-JSON encoder omits it
from hash bytes regardless (§8), because the encoder filters `fieldValue !==
undefined` at the object level (`:1270`) irrespective of whether the source
object declared the key.

### 3.7 `CanonicalIntrinsicGapRegion` (`intrinsicGapRegions.ts:26-39`)

```
kind: 'enclosed-cavity' | 'hull-open-gap'
boundary: Path64                  // clipper2-ts integer-grid ring, always counter-clockwise (see §4)
holes: ReadonlyArray<Path64>      // always clockwise, sorted by canonicalRing (see §5)
areaMm2: number
doubledAreaGrid2: string          // BigInt-as-decimal-string, net of holes
aabb: { minX, minY, maxX, maxY }  // in grid units (integers), NOT millimeters
canonicalKey: string              // `${canonicalRing(boundary)}|${holes.map(canonicalRing).join('|')}`
```

Note the unit inconsistency baked into the type: `areaMm2` is millimeters²,
but `aabb` fields are raw grid integers (0.001 mm units), not millimeters —
confirmed by `pathBounds` operating directly on `Path64` grid points
(`intrinsicGapRegions.ts:213-227`) with no `fromGrid` conversion. A Rust port
must preserve this exact unit split field-by-field; do not "fix" it by
converting `aabb` to millimeters, since nothing in this cluster currently
reads `aabb` at all (grep confirms `region.aabb` has no reader in these three
files — it is part of the public shape but unconsumed here; a consumer
elsewhere may rely on grid units).

### 3.8 `IntrinsicCollisionFamily` (`intrinsicStrictFamilyPortfolio.ts:41-48`)

```
key: string                 // JSON.stringify([interchangeabilityKey, canonicalCyclicPolygonKey(points)])
members: ReadonlyArray<IrregularPreparedPiece>   // in first-occurrence order within the input `pieces` array
firstBaselineIndex: number  // index in `pieces` of the first member encountered
collisionAreaMm2: number    // measured from the FIRST member's collisionPolygon only
maximumSideMm: number       // measured from the FIRST member only
aspectRatio: number         // measured from the FIRST member only
```

`collisionAreaMm2`/`maximumSideMm`/`aspectRatio` are derived once from
`group.members[0]` (`intrinsicStrictFamilyPortfolio.ts:109-119`), not
averaged or validated against other members — a Rust port must not
"improve" this by computing per-member statistics; other members are assumed
(not verified) to be geometrically identical because the key already encodes
the canonical polygon shape.

---

## 4. Algorithm state and every mutation point

There is **no module-level mutable state** in any of the three files (no
top-level `let`). All mutation is confined to variables local to one call of
`constructIntrinsicStrictState` (or, in the dead-code paths, one call of
`runIntrinsicStrictFamilyPortfolio` / `groupIntrinsicCollisionFamilies`).
`IrregularBeamState` itself is immutable (every transition method returns a
new instance with a `parent` back-link); this cluster only ever *replaces* its
local `state` binding, never mutates a `IrregularBeamState` instance in place.

### 4.1 Inside `constructIntrinsicStrictState` (`intrinsicStrictDecoder.ts:401-866`)

Call-scoped mutable bindings and every mutation point:

| Variable | Declared | Mutated at | Semantics |
| --- | --- | --- | --- |
| `state` | `:489-495` (seed) | `:801-806` (once per piece: either `selected.state` or `state.withUnplacedPiece(...)`) | Current placement state; reassigned exactly once per piece iteration, never mid-piece |
| `stepTrace` | `:511-513` (seeded from `checkpoint?.stepTrace`) | `.push(...)` at `:728-734` | One entry per **committed** piece boundary; **not** pushed if the evaluation cap breaks `pieceLoop` mid-piece (see §10) |
| `gapFillEvidence` | `:514-516` | `.push(...)` at `:786-799` | Only pushed when `selected.containingGap !== undefined`, i.e. only under `{kind:'gap-contained'}` mode with a real containment hit |
| `candidateEvaluationCount` | `:517` | `+= 1` semantics via `candidateEvaluationCount += 1` at `:630`, gated by `captureCandidateEvaluationCount` | Global scored-candidate counter across the whole call, checked against the cap **before** incrementing (`:622-628`) |
| `truncationReason` | `:518` | assigned once, `:626` | Set only on evaluation-cap break; never reset |
| `pauseReason` | `:519` | assigned once, `:813` | Set only on completed-piece-boundary pause; mutually exclusive in practice with `truncationReason` because both `break` the loop |
| `candidateGenerationMs` | `:520-521` | `+=` at `:613` (in a `finally`, so always executes if `capturePhaseTimings`) | Time spent in `transformCollisionGeometry` + `generatePlacementCandidates` per transform |
| `candidateStateScoringMs` | `:522-523` | `+=` at `:670` (also a `finally`), and `+=` at `:720` (anchoring time folded in) | |
| `candidateStatePhaseTimings` (object) | `:526-547` | fields incremented via `+=` inside `scoreCandidate` (`:1416,1439,1445,1451,1474`) and directly at `:664-665,721-722` | Mutated **by reference** — `scoreCandidate` receives the same object every call within one piece's transform/candidate loop and accumulates into it; this is the one place in the cluster where a callee mutates caller-owned state through a passed reference rather than returning a new value |
| `completedPieceBoundaries` | `:548` | `+= 1` at `:807` | Counts committed pieces since resume; drives the pause condition at `:808-812` |
| `candidatesByFamily` (Map) | recreated per piece, `:561` | `.set(family, scored)` at `:651` when no incumbent or `compareLocalScores(scored.score, incumbent.score) < 0` | Best-per-transform-family placement so far for the current piece |
| `containedCandidatesByFamily` (Map) | recreated per piece, `:562-565` | `.set(family, containedScored)` at `:660` under the analogous rule using `compareGapContainedCandidates` | Best-per-family gap-contained placement so far |

`candidatesByFamily`/`containedCandidatesByFamily` are **recreated fresh every
piece iteration** (`:561-565`, inside the `pieceLoop` body) — there is no
cross-piece reuse or leakage.

### 4.2 Inside `scoreCandidate` (`intrinsicStrictDecoder.ts:1394-1498`)

Pure with one exception: if `input.phaseTimings` is defined, it mutates the
caller's `MutableCandidateStatePhaseTimings` object in place (see 4.1 row
above). Otherwise it only reads `input.state`/`input.candidate`/etc. and
returns a new `ScoredCandidate | undefined`.

### 4.3 Inside `intrinsicGapRegions.ts`

No persistent state. Each call to `deriveCanonicalIntrinsicGapRegions` or
`candidateContainedInIntrinsicGap` allocates fresh `PolyTree64` instances
(`:51-52,93`) that are local to that call and never retained.

### 4.4 Inside `intrinsicStrictFamilyPortfolio.ts`

`groupIntrinsicCollisionFamilies` builds one local `Map<string, {members,
firstBaselineIndex}>` (`:98`), mutated via `.set`/`existing.members.push`
(`:102-106`) during a single `forEach` pass, then converted to an array and
discarded. `buildIntrinsicFamilyPortfolioChromosomes` (dead path) similarly
builds one local `identities` Map (`:220`) for duplicate detection within one
call. No state survives a single function invocation.

---

## 5. Ordering sources

Every sort, every `Map`/`Set` whose iteration order is observable, and every
loop order that reaches output, keys, traces, or selection:

1. **Transform iteration order per piece**: `[...piece.transforms].sort(transformCandidateOrder)`
   (`intrinsicStrictDecoder.ts:572`). `Array.prototype.sort` is guaranteed
   stable (ES2019+); relies on stability only in the (effectively unreachable)
   case where two transform candidates compare exactly equal under
   `transformCandidateOrder` (§6.1) — `index` is expected unique per
   `IrregularTransformCandidateSchema`, so this is a total order in practice.
2. **Candidate iteration order per transform**: whatever order
   `nfpIfpService.generatePlacementCandidates` returns (external to this
   cluster) or the single-element array from `originAnchorCandidates`
   (`:1742-1756`) for the first piece. This order is iterated **in place**
   (`for (const candidate of legalCandidates)`, `:621`) with no re-sort; it
   directly determines which candidate is scored first, which determines tie
   resolution into `candidatesByFamily`/`containedCandidatesByFamily` (item 4).
3. **`candidatesByFamily` / `containedCandidatesByFamily` Map insertion
   order**: a JS `Map` preserves *key* insertion order; `.set()` on an
   existing key does **not** move it. So `familyWinners =
   [...candidatesByFamily.values()]` (`:711`) is ordered by **first time each
   transform-family key was encountered** (across the whole sorted-transform ×
   candidate double loop for that piece), not by final score. This order is
   the input to `selectIntrinsicStrictFamilyWinner`/`selectGapContainedWinner`,
   both of which have order-sensitive tie behavior (§6.2).
4. **Tie resolution within one family bucket**: `candidatesByFamily.set` only
   overwrites when `compareLocalScores(scored.score, incumbent.score) < 0`
   (strict `<`, `:650`) — on an exact-zero comparison, the **first-encountered**
   candidate for that family is kept, not the last. Same rule for
   `containedCandidatesByFamily` at `:656-659` using `compareGapContainedCandidates`.
5. **Gap-region containment ranking per candidate**:
   `input.gapRegions?.filter(...).toSorted((a,b) => a.areaMm2 - b.areaMm2 ||
   a.canonicalKey.localeCompare(b.canonicalKey))[0]` (`intrinsicStrictDecoder.ts:1466-1472`)
   — smallest containing region wins, tie-broken by `canonicalKey` locale
   compare (see §12 for the locale-compare hazard).
6. **Gap-region output order**: `deriveCanonicalIntrinsicGapRegions` sorts its
   result by `compareBigInts(doubledAreaGrid2) || canonicalKey.localeCompare(...)`
   (`intrinsicGapRegions.ts:67-71`) — ascending doubled area, then locale
   compare tie-break. This order is directly observable wherever `gapRegions`
   is iterated (it is, but only via `.filter`, so the sort mainly matters
   through the tie-break rule of item 5, not through iteration order per se).
7. **Hole ordering within one gap region**: `holes.map(canonicalGridClockwise)
   .filter(...).toSorted((a,b) => canonicalRing(a).localeCompare(canonicalRing(b)))`
   (`intrinsicGapRegions.ts:145-148`) — locale-compare again.
8. **`canonicalRing` variant selection**: enumerates every rotation × both
   directions of a ring's point list as `"x,y;x,y;..."` strings and takes
   `variants.toSorted()[0]` with **no comparator**
   (`intrinsicGapRegions.ts:229-238`, and the structurally identical
   `canonicalCyclicPolygonKey` at `intrinsicStrictFamilyPortfolio.ts:514-528`)
   — this is JS's default array sort, i.e. UTF-16 code-unit order on the
   stringified elements, **not** locale-aware. Verified in §12: this ordinal
   sort agrees with Rust's natural `str`/byte order for this alphabet
   (digits, `,`, `;`, `-`), unlike the `.localeCompare` calls elsewhere.
9. **Family grouping order**: `groupIntrinsicCollisionFamilies`'s returned
   array is `[...groups.entries()].map(...)` (`intrinsicStrictFamilyPortfolio.ts:108`)
   — Map insertion order = first-occurrence order of each family key while
   scanning `pieces` left to right (`:99-107`). `family.members` is push
   order (first-occurrence order within that family). Both are directly
   observable in `IntrinsicCollisionFamily.members` and matter to any
   consumer that is order-sensitive (the live consumers,
   `intrinsicPeriodicCells.ts` and `intrinsicPeriodicFamilyPortfolio.ts`, are
   outside this cluster's file scope but do consume this order — see their
   own characterization for how they use it).
10. **Terminal orientation selection**: `selectTerminalOrientation` iterates
    `[0, 90] as const` in that fixed order (`intrinsicStrictDecoder.ts:1798`),
    collects legal `{state, rotationDeg, canonicalHash}` entries, then picks
    `.toSorted((a,b) => a.canonicalHash.localeCompare(b.canonicalHash) ||
    a.rotationDeg - b.rotationDeg)[0]` (`:1815-1819`) — hash locale-compare
    first, numeric rotation second. Both `0` and `90` are always attempted
    regardless of order; only the tie-break sort matters.
11. **Pareto front internal ordering**: `orderIntrinsicStrictParetoFront`
    (`:2321-2343`) repeatedly extracts, from the *remaining* pool, the
    `.toSorted(objective.compare || canonicalGeometryHash.localeCompare)[0]`
    winner for each objective in `intrinsicStrictFrontSelectionObjectives`
    order (compactness → void-topology → contact,
    `:2235-2239`), removing the winner from `remaining` each time and
    repeating the whole three-objective cycle until `remaining` is empty or a
    full pass selects nothing. This is **not** a single stable sort by a
    combined key; it is a round-robin "take the best-by-objective-A, then
    best-by-objective-B, then best-by-objective-C, repeat" peeling order. A
    Rust port must reproduce this peeling loop exactly, not replace it with
    one `sort_by` call — the visitation order differs.
12. **Rank partitioning across fronts**: `rankIntrinsicStrictParetoPartition`
    (`:2290-2319`) repeatedly computes the Pareto frontier of whatever
    remains, orders it via item 11, appends, and removes those members,
    until nothing remains or (as a fallback) sorts the remainder by
    `canonicalGeometryHash.localeCompare` (`:2304-2309`) if a "frontier" ever
    comes back empty (only possible if `remaining` is itself empty, so this
    branch is effectively unreachable dead code guarding against an
    impossible state — still must be ported faithfully).
13. **`intrinsicStrictCanonicalJson` object key order**: `Object.entries(value)
    .filter(fieldValue !== undefined).toSorted(([a],[b]) =>
    a.localeCompare(b))` (`intrinsicStrictDecoder.ts:1269-1271`) — every
    object's keys are sorted by locale compare before encoding (§8).
14. **`intrinsicStrictCanonicalJson` Map entry order**: `[...value.entries()]
    .toSorted(([a],[b]) => String(a).localeCompare(String(b)))`
    (`:1264-1266`).
15. **`samePieceIdSet`**: sorts both arrays with **default** `.toSorted()`
    (`:1249-1250`) — ordinal, not locale — purely for a set-equality check;
    the sort's own resulting order is never observed beyond the boolean
    equality result, so any consistent total order would do, but the exact
    algorithm (`Array.prototype.sort`, i.e. not necessarily identical low-level
    tie behavior to a Rust sort for genuinely-equal elements) is irrelevant here
    since `PieceId` values are unique per piece.
16. **`selectRepeatedElongatedFamilies`** (dead path): sorted by
    `collisionAreaMm2` desc, `maximumSideMm` desc, `key.localeCompare` asc
    (`intrinsicStrictFamilyPortfolio.ts:184-189`), then `.slice(0,2)`.

---

## 6. Comparators and tie rules (exact chains, signs, file:line)

### 6.1 `transformCandidateOrder` (`intrinsicStrictDecoder.ts:53-58`)

`Order.combineAll([index asc, rotationDeg asc, mirrored asc(false<true), reason
asc(ordinal string)])`. Effect's `Order.combineAll` short-circuits on the
first nonzero sub-order (`node_modules/.pnpm/effect@4.0.0-beta.89/node_modules/effect/dist/Order.js:324-333`).
`Order.Number` treats `NaN` as **less than** every non-NaN number and equal to
another `NaN` (`Order.js:112-116`) — different from `Array.prototype.sort`'s
default numeric-comparator instability. `Order.String` is `self < that ? -1 :
1` (`Order.js:80`), i.e. plain JS `<`, which is UTF-16 code-unit ordinal — not
locale-aware, unlike most of this file's own comparators (§12).

### 6.2 `selectIntrinsicStrictFamilyWinner` (`intrinsicStrictDecoder.ts:1563-1609`)

- `comparatorMode === 'legacy-absolute-envelope'`: `candidates.toSorted(compareLegacyAbsoluteEnvelopeCandidates)[0]`.
- Otherwise (`'pure-growth'` or `'contact-band'`): `pureLeader =
  candidates.reduce((best, c) => best===undefined || compareLocalScores(c.score,
  best.score) < 0 ? c : best, undefined)` (`:1570-1574`) — **strict `<`**, so on
  an exact tie the earlier element in the input array order (§5 item 3) wins,
  never the later one.
  - `'pure-growth'`: return `pureLeader` directly.
  - `'contact-band'`: filter candidates to those within a bounded envelope of
    `pureLeader` (exact-grid rule if `.exact` present on both:
    `candidateExact.maximumSideGrid === leaderExact.maximumSideGrid &&
    100n * BigInt(envelopeAreaGrid2_candidate) <= 100n *
    BigInt(envelopeAreaGrid2_leader) + BigInt(movingDoubledAreaGrid2_candidate)`,
    `:1589-1595` — i.e. candidate area may exceed the leader's by at most
    exactly `1%` of the **candidate's own** moving-piece doubled area, an
    exact integer inequality with no epsilon; float fallback when `.exact` is
    absent uses `canonicalLinearMetric`/`canonicalAreaMetric` rounded
    comparison with a `0.02 * movingCollisionAreaMm2` allowance, i.e. **2%**,
    not 1% — the exact-grid rule and the float-fallback rule use **different**
    percentages (1% vs 2%) for nominally the same "growth band" concept; this
    is intentional existing behavior, not a bug, and must be preserved exactly
    as two distinct thresholds), then `.toSorted(compareContactBandCandidates)[0]`.

### 6.3 `compareLocalScores` (`intrinsicStrictDecoder.ts:1653-1670`)

Chain (each `||` falls through only on exact `0`):
1. `compareExactLocalEnvelopes(first, second, 'maximum-side-first')` if both
   have `.exact`, else `undefined` (falls through to float chain).
   - exact mode `'maximum-side-first'`: `maximumSideGrid asc || areaGrid2 asc
     (BigInt compare) || envelopeSpanGrid asc` (`:1682-1685`).
2. Float fallback (only reached when `.exact` missing on either side, or as
   the tie-continuation after an exact `0`... **note**: `exact ??
   (floatChain)` means the float chain only runs when `compareExactLocalEnvelopes`
   returned `undefined` (missing `.exact`), **not** when it returned `0`
   (both `undefined` and `0` are falsy-adjacent in JS but `??` only treats
   `null`/`undefined` as "use the right side" — an exact `0` tie is a
   legitimate final answer for this term and does **not** fall through to the
   float recomputation): `canonicalLinearMetric(maximumSideMm) asc ||
   canonicalAreaMetric(envelopeAreaMm2) asc || canonicalLinearMetric(envelopeSpanMm) asc`.
3. `second.sharedBoundaryLengthMm - first.sharedBoundaryLengthMm` (descending
   raw-float subtraction, **not** rounded via `canonicalLinearMetric` — a
   different rounding policy than the geometry terms above it).
4. `first.canonicalCombinedGeometryKey.localeCompare(second.canonicalCombinedGeometryKey)`.

### 6.4 `compareLegacyAbsoluteEnvelopeCandidates` (`:1612-1632`) and `compareContactBandCandidates` (`:1634-1651`)

Both reuse `compareExactLocalEnvelopes(..., 'area-first')` (area asc,
maximumSide asc, span asc — note the **different** field order from
`'maximum-side-first'`) as their primary exact term, but differ in outer
shape: legacy puts area/side/span **before** sharedBoundaryLength before the
geometry-key tiebreak; contact-band puts sharedBoundaryLength **before**
area/side/span. Both end in `canonicalCombinedGeometryKey.localeCompare`.
These are three genuinely different comparators (`compareLocalScores`,
`compareLegacyAbsoluteEnvelopeCandidates`, `compareContactBandCandidates`)
sharing a common exact-envelope primitive but different term ordering — a
Rust port must implement all three distinctly, not parameterize one generic
comparator carelessly (the term order differences are observable).

### 6.5 `compareGapContainedCandidates` (`intrinsicStrictDecoder.ts:1548-1560`)

`compareBigIntAscending(containingGap.doubledAreaGrid2) ||
(second.sharedBoundaryLengthMm - first.sharedBoundaryLengthMm) ||
compareLocalScores(first.score, second.score)`. Smallest containing gap
wins first; then largest shared-boundary length; then the full local-score
chain as a final tiebreak.

### 6.6 `selectGapContainedWinner` (`:1536-1546`)

`candidates.filter(hasContainingGap).toSorted(compareGapContainedCandidates)[0]
?? selectIntrinsicStrictFamilyWinner(candidates, 'pure-growth')` — if **no**
candidate (across the combined `[...containedCandidatesByFamily.values(),
...familyWinners]` list, §5 item 3) has a containing gap, it falls back to
plain pure-growth selection over the **combined** list (which includes both
gap-tagged-but-filtered-out and plain family-winner entries) — i.e. the
fallback is not restricted to `familyWinners` alone; duplicate entries
between the two source Maps could both appear if a family key happens to be
both a family winner and separately a "best contained" pick for the same
family — in practice `containedCandidatesByFamily`'s members are a subset of
transform-family buckets already represented in `candidatesByFamily`, but
they are **different `ScoredCandidate` objects** for the same family key
(best-under-`compareGapContainedCandidates` vs best-under-`compareLocalScores`) so
duplication is real, not just theoretical, and `selectIntrinsicStrictFamilyWinner`'s
`reduce` (§6.2) will encounter both.

### 6.7 Completed-layout dominance and ranking (`:2092-2343`)

- `compareIntrinsicStrictCompactness` (`:2120-2142`): exact-grid
  `maximumSideGrid asc || areaGrid2 asc(BigInt) || spanGrid asc`, float
  fallback `canonicalLinearMetric`/`canonicalAreaMetric` rounded chain.
- `compareIntrinsicStrictVoidTopology` (`:2144-2176`): `enclosedCavityCount
  asc` first (always, both exact and float paths, plain int subtraction);
  then, if both `.exact`, `totalEnclosedCavityDoubledAreaGrid2 asc(BigInt) ||
  compareExactRatio(largestHullGap/hull) asc || compareExactRatio(hullWaste/hull) asc`;
  float fallback uses `totalEnclosedCavityAreaMm2` rounded, then raw-float
  ratio subtraction (no rounding) for the two ratio terms.
- `compareIntrinsicStrictContact` (`:2178-2216`): `isolatedPieceCount asc ||
  positiveContactComponentCount asc || largestPositiveContactComponentSize
  **desc**` first (plain int/float subtraction, note the sign flip on the
  third term: `second.largest - first.largest`); then, if both `.exact`,
  `compareExactRatio(second.largestSize/second.placedCount,
  first.largestSize/first.placedCount)` (**reversed operand order** — this
  computes descending-ratio-of-largest-component-share as an ascending
  compare by swapping first/second, equivalent to `-1 * ratio(first vs
  second)`) `|| occupiedOutsideLargestContactComponentDoubledAreaGrid2
  asc(BigInt)`; float fallback: `largestPositiveContactComponentRatio desc ||
  canonicalAreaMetric(occupiedAreaOutsideLargestContactComponentMm2) asc`; then
  regardless of exact/float: `totalStructuralContacts desc ||
  dominantStructuralContacts desc || contactUnits desc ||
  canonicalLinearMetric(sharedBoundaryLengthMm) desc`.
- `compareIntrinsicStrictCompletedLayoutDominance` (`:2248-2261`): **Pareto**
  dominance over exactly `[compactness, voidTopology]` (contact is
  deliberately excluded from dominance, per the doc comment at `:2241-2247` —
  "Exact contact receives one bounded archive-selection turn, but cannot veto
  strict improvement on both geometric axes"). Returns `-1` iff first is
  strictly better on at least one of the two objectives and never worse on
  the other (classic Pareto dominance, computed via `firstBetter`/`secondBetter`
  booleans with early-return `0` once both are true); `0` for genuine
  tradeoffs or equality.
- `selectIntrinsicStrictCompletedParetoFront` (`:2271-2281`): keeps only
  non-dominated layouts (`O(n^2)` pairwise check using `!==` object identity,
  not value equality — **duplicate metric objects with identical values but
  different identity would each be checked against the other and neither
  would dominate**, since `intrinsicStrictCompletedLayoutDominates` never
  returns true for equal values; this matters only if the caller passes
  literal duplicate objects, which does not happen on the traced production
  path), then orders via `orderIntrinsicStrictParetoFront` (§5 item 11).
- `rankIntrinsicStrictCompletedLayouts` = `rankIntrinsicStrictParetoPartition`
  (§5 item 12): repeatedly peels Pareto fronts.

### 6.8 `evaluateIntrinsicStrictCertificate` (`:1956-2018`) and `exactStrictRelativeDeficit` (`:2059-2090`)

Four independent floor checks against `INTRINSIC_STRICT_COHESION_FLOORS`
(`:60-65`: `maximumEnclosedCavityCount: 2`, `maximumIsolatedPieceCount: 2`,
`minimumLargestPositiveContactComponentRatio: 0.8`,
`maximumLargestOccupiedHullGapRatio: 0.15`). Each violated floor accumulates a
`relativeDeficitSum` term via **float** `Math.min(1, deficit/floor)`
(`:1962-2005`), *and*, independently, `exactStrictRelativeDeficit` computes
the same four terms as exact `bigint` fractions summed via
`greatestCommonDivisor`-reduced `ExactFraction` addition (`:2025-2090`) —
**the exact-fraction thresholds are hardcoded literals** (`2n`, `4n*placedCount`,
`5n*largestComponent`, `20n*hullGap`, `3n*hull`) that must exactly mirror
`INTRINSIC_STRICT_COHESION_FLOORS`'s decimal values (`2`, `0.8 = 4/5`,
`0.15 = 3/20`) — if the floors constant is ever changed, `exactStrictRelativeDeficit`'s
literals must be updated in lockstep by hand; there is no shared derivation.
A Rust port should derive both from one source of truth if it can prove
byte-identical output, or otherwise preserve this exact duplication risk
faithfully with a test that pins both to the current values.
`largestComponentBelowFloor`/`largestHullGapAboveFloor` (`:1978-1997`) each
fork on `metrics.exact !== undefined` to use the exact-integer inequality
(`5n*largestComponentSize < 4n*placedCount`, `20n*hullGapDoubled >
3n*hullDoubled`) instead of the float ratio comparison — **the exact and
float paths can disagree at floor boundaries** due to rounding in the float
ratio fields, but on this cluster's production path `metrics.exact` is always
present (§3.5), so the float branch is dead in practice but must still be
ported faithfully as a defensive fallback.

### 6.9 `intrinsicCollisionFamilyKey` grouping key equality (`intrinsicStrictFamilyPortfolio.ts:124-130`)

Not a comparator but an **equality key**: `JSON.stringify([interchangeabilityKey
?? source.id, canonicalCyclicPolygonKey(collisionPolygon.points)])`. Two
pieces are the same family iff this string is identical. `canonicalCyclicPolygonKey`
picks the lexicographically-smallest (ordinal, §5 item 8) of all
`2 * points.length` cyclic rotation/direction variants of the grid-quantized
point list, so the key is invariant to starting vertex and winding direction
but **not** to translation (raw grid coordinates are embedded, not
translation-normalized) — two congruent-but-translated collision polygons
get **different** family keys.

---

## 7. Numeric semantics

### 7.1 Canonical grid conversion — `toGridMm` / `fromGrid` (`src/workers/irregular/clipper2OffsetPolicy.ts:44-58`)

`toGridMm(valueMm)`: scale by `1000`, then `Math.sign(valueMm) *
Math.floor(Math.abs(valueMm * 1000) + 0.5)` — **round half away from zero**,
distinct from JS's native `Math.round` (§7.3). Returns `undefined` if the
input is non-finite or the scaled result is not `Number.isSafeInteger`. Used
pervasively across all three files for every millimeter→grid conversion
(`intrinsicStrictDecoder.ts:735-738,1508-1509,1714-1717,1745-1746`;
`intrinsicGapRegions.ts:81-82,180-181`; `intrinsicStrictFamilyPortfolio.ts:484-487,518-519`).
Note: `Math.sign(0) === 0` and `Math.sign(-0) === -0`; for `valueMm = -0`,
`gridValue = -0 * 0` which is IEEE-754 `-0` — `toGridMm(-0)` therefore returns
`-0`, and `Number.isSafeInteger(-0) === true`. Downstream `BigInt(-0)` is `0n`
(BigInt has no signed zero), so this negative-zero grid value is only
observable if compared with `Object.is` before being widened to `BigInt` or
used in a further float computation that is sign-sensitive. No call site in
these three files performs such a comparison, but a Rust port converting `f64`
`-0.0` through an equivalent `signum() * (abs*1000.0 + 0.5).floor()`
expression must confirm it produces the same downstream-neutral `-0.0`/`0`
behavior at every consumer, not assume it is automatically safe.

`fromGrid(value)`: `value / 1000`, a pure dequantization with **no**
additional rounding — a Rust port must not re-round on the way back out.

### 7.2 Exact BigInt arithmetic

- `canonicalCollisionArea` (`intrinsicStrictDecoder.ts:1701-1739`): doubled
  signed area via the shoelace formula computed entirely in `BigInt`
  (`doubledAreaGrid2 += BigInt(firstX)*BigInt(secondY) -
  BigInt(secondX)*BigInt(firstY)`, `:1726-1728`), then `areaMm2 =
  Number(absoluteDoubledAreaGrid2) / 2_000_000` — the **only** place float
  reenters is the final `Number(bigint)` conversion for the millimeter
  projection; the exact `doubledAreaGrid2` string is retained separately.
  Rejects (`areaMm2 <= 0`, i.e. degenerate/zero-area polygons are excluded,
  `:1733`).
- `measureIntrinsicStrictEnvelopeFromState` (`:1500-1534`): `envelopeAreaGrid2
  = (BigInt(widthGrid) * BigInt(heightGrid)).toString()` — a genuine BigInt
  product, not a float approximation, encoded as decimal string (§3.4/§8).
- `canonicalGridMath.ts` (§2.4) provides `canonicalGridCross`
  (`canonicalGridMath.ts:29-48`, full BigInt cross product) and
  `canonicalGridCrossSign` (`:82-109`), which has a **documented fast path**:
  if every one of the three points has `|coord| <=
  CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT = 2**25 - 1 = 33554431`
  (`canonicalGridMath.ts:63`, grid units = 0.001 mm, so ≈ ±33.5 m), the cross
  product sign is computed directly in `Number` arithmetic (no BigInt
  allocation) with a proof in the source comment (`:50-62`) that this cannot
  round given IEEE-754 binary64's 53-bit mantissa. Otherwise it falls back to
  the exact `BigInt` path. A Rust port must reproduce **both** branches and
  the **exact same limit constant**, not just "always use `i64`/`i128`" —
  the point of this design is a measured perf tradeoff, and the boundary
  value itself (`2**25 - 1`) is a correctness-relevant constant, not a
  tuning knob.
- `doubledGridAreaToMm2(doubledAreaGrid2: bigint)` (`canonicalGridMath.ts:198-201`):
  `Number(doubledAreaGrid2) / 2_000_000`, returns `undefined` if not finite
  (only possible for astronomically large BigInts beyond `Number` range).

### 7.3 `Math.round` vs `toGridMm`'s rounding — two different tie-breaking rules in the same cluster

`canonicalLinearMetric`/`canonicalAreaMetric` (`intrinsicStrictDecoder.ts:1692-1699`)
use JS's native `Math.round(valueMm * 1_000)` / `Math.round(valueMm2 *
1_000_000)`. **JS `Math.round` rounds ties toward `+Infinity`**, not away from
zero: verified directly, `Math.round(-0.5) === -0`, `Math.round(-1.5) ===
-1`, `Math.round(-2.5) === -2`, `Math.round(2.5) === 3`. Rust's `f64::round()`
rounds **half away from zero** (`(-1.5_f64).round() == -2.0`,
`(-2.5_f64).round() == -3.0`) — the **opposite** tie direction for negative
half-integers. This is a **provable, concrete divergence**, not a
theoretical one. A correct Rust port of `canonicalLinearMetric`/`canonicalAreaMetric`
must implement `(x + 0.5).floor()` (which matches JS `Math.round`'s
toward-`+Infinity` tie rule for all finite `x`), **not** call `f64::round()`.
This is independent from, and must not be confused with, `toGridMm`'s
"round half away from zero" policy (§7.1) — the two grid-conversion families
in this cluster use genuinely different rounding rules and both must be
preserved exactly, each in its own call sites. See §12 and portRisks for the
severity ranking.

### 7.4 Signed-boundary/raw-float subtraction terms used as comparator tiebreaks

Several comparator terms deliberately use **unrounded** float subtraction
where sibling terms use rounded (`canonicalLinearMetric`/`canonicalAreaMetric`)
comparison: `second.sharedBoundaryLengthMm - first.sharedBoundaryLengthMm`
appears in `compareLocalScores` (`:1667`), `compareLegacyAbsoluteEnvelopeCandidates`
(`:1627`), `compareContactBandCandidates` (`:1640`), and
`compareGapContainedCandidates` (`:1557`) — always raw float subtraction, no
`Math.round`/grid quantization. Any Rust port that "cleans up" these to use
the same rounding as neighboring terms would change tie behavior at
sub-micrometer boundary cases. Preserve the asymmetry exactly.

### 7.5 `Number.isFinite` / `Number.isSafeInteger` gates

- `measureIntrinsicStrictEnvelopeFromState` requires all of
  `[maximumSideMm, envelopeAreaMm2, envelopeSpanMm, maximumSideGrid,
  envelopeSpanGrid]` to pass `Number.isFinite` (`:1525-1533`) — note
  `envelopeAreaGrid2` (the BigInt-string field) is **not** in this finiteness
  list (it cannot be non-finite by construction, being a BigInt), but
  `envelopeAreaMm2` (the float projection) is checked.
- `scoreCandidate` requires `[maximumSideMm, envelopeAreaMm2, envelopeSpanMm,
  sharedBoundaryLengthMm]` all finite (`:1456-1463`) before proceeding.
- `canonicalCollisionArea` requires `areaMm2` finite and `> 0`
  (`:1733`).
- `validateIntrinsicStrictDirectCheckpoint` uses `Number.isSafeInteger` on
  `nextPieceIndex` and `candidateEvaluationCount` (`:930,1003`), and
  `Number.isFinite` on `activeRuntimeMs` and every phase-ledger value
  (`:1006-1007`, `intrinsicStrictDirectPhaseLedgerValid` `:1225-1233`).
- `canonicalNumber`-style `NaN`/`Infinity` handling is **not** present in
  this cluster's own numeric gates (it lives in `irregularBeamState.ts`'s
  `canonicalNumber`, out of scope) — but see §8.2 for how `NaN`/`Infinity`
  values that **do** reach this cluster's own `gapFillEvidence` fields get
  silently coerced to JSON `null` by `intrinsicStrictCanonicalJson`.

### 7.6 `Number.isSafeInteger` as the grid-coordinate validity gate

`canonicalGridMath.ts`'s `isCanonicalGridCoordinate` (`canonicalGridMath.ts:8-10`)
is exactly `Number.isSafeInteger(value)` — every grid-math function
(`canonicalGridCross`, `canonicalGridSignedDoubledArea`,
`canonicalGridConvexHull`, etc.) returns `undefined` for any point outside
this range rather than silently truncating. This propagates as `undefined`
through `deriveCanonicalIntrinsicGapRegions` (e.g. `:49,123,135,142`) and
ultimately disables gap-contained scoring for that piece/state rather than
producing wrong geometry.

---

## 8. Serialization and hashing

### 8.1 `intrinsicStrictCanonicalJson` (`intrinsicStrictDecoder.ts:1257-1277`) — the only custom canonical encoder in this cluster

```
bigint            -> JSON.stringify(value.toString())        // quoted base-10 string
null | non-object -> JSON.stringify(value)                    // includes numbers, strings, booleans, undefined(!)
Array             -> `[${value.map(recurse).join(',')}]`
Map               -> sorted by String(key).localeCompare, then re-encoded as [[k,v],...] via the Array branch
object (else)     -> Object.entries(value).filter(([,v]) => v !== undefined)
                       .toSorted(([a],[b]) => a.localeCompare(b))
                       .map(([k,v]) => `${JSON.stringify(k)}:${recurse(v)}`)
                       joined with ',' inside `{...}`
```

Two independent call sites, both inside this file:
`intrinsicStrictDirectRequestFingerprint` (`:1021-1056`, hashed at `:1032-1055`)
and `intrinsicStrictDirectCheckpointIntegrityHash` (`:1058-1078`, hashed at
`:1062-1077`). Both feed `createHash('sha256').update(json).digest('hex')`.

**Hazard 1 — `undefined` inside a bare array leaf.** The array branch does
**not** filter `undefined` elements (only the object-field branch does, at
the object level). If `intrinsicStrictCanonicalJson` is ever called on an
array containing a raw `undefined` (not wrapped in an object), the leaf
branch executes `JSON.stringify(undefined)`, which returns the **actual JS
value `undefined`** (not the string `"undefined"`). `Array.prototype.join`
then stringifies that array element as an **empty string** (`[undefined].join(',')
=== ''`, per the ECMA-262 `Array.prototype.join` spec treating `null`/`undefined`
elements as `""`). On the traced call inputs (`stepTrace`, `gapFillEvidence`,
prepared-piece arrays, `remainingPreparedIds`, `frozenPlacementOrder`), every
array element is itself an object or a defined primitive (string/number), so
this branch is not currently reachable — but it is a latent, silent
correctness trap if any future field adds an array of optional primitives.
Document it exactly as-is; do not "fix" it in the Rust port (that would be a
behavior change), but do add an explicit unit test around it so any future
change that would trigger it is caught before it silently changes hash bytes.

**Hazard 2 — `NaN`/`Infinity` inside numeric fields collapse to JSON `null`,
and this is load-bearing today.** `gapFillEvidence` entries can genuinely
contain `Number.NaN` (`sharedBoundaryLengthMm`, when
`afterSharedBoundaryLengthMm < beforeSharedBoundaryLengthMm`,
`intrinsicStrictDecoder.ts:782-785,793`) and `Number.POSITIVE_INFINITY`
(`envelopeMaximumSideDeltaMm`/`envelopeAreaDeltaMm2`, when `beforeBounds` or
`afterBounds` is `undefined`, `:771-779`). Both are real production values
that reach `intrinsicStrictCanonicalJson` via `gapFillEvidence` inside
`intrinsicStrictDirectCheckpointIntegrityHash`'s input object (`:1071`).
JavaScript's native `JSON.stringify` converts `NaN` and `±Infinity` to the
literal `null` (this is standard `JSON.stringify` behavior, not a bug in this
codebase) — so **these fields silently become `null` in the hashed bytes**,
and `intrinsicStrictDirectCheckpoint.integrityHash` depends on this coercion.
A Rust port using `serde_json` **must not** let `serde_json::to_string`
error or panic on `NaN`/`Infinity` floats (its default behavior is to reject
them or, depending on configuration, produce non-JSON-spec output) — it must
explicitly detect non-finite `f64` values wherever this canonical encoder is
reimplemented and emit the JSON token `null` in their place, matching V8's
`JSON.stringify` exactly. This is the single highest-value concrete finding
for the checkpoint-hashing port (see portRisks).

**Object key ordering** uses `.localeCompare` (`:1271`), not ordinal sort —
see §12 for why this must be verified against Rust's string ordering rather
than assumed. Field names here are camelCase ASCII identifiers with no shared
prefixes differing only by case, so this specific usage is lower-risk than
the geometry-key comparisons, but "lower risk" is not "zero risk" without an
explicit differential check (prompt §8.1: "reproduce numeric semantics
deliberately rather than relying on coincidental similarity").

### 8.2 What actually gets hashed

- **Request fingerprint** (`intrinsicStrictDirectRequestFingerprint`,
  `:1021-1056`): `{version, producerRole, candidateMode, settings,
  settlement: {maximumRuntimeMs, maximumCandidateEvaluationCount,
  capturePhaseTimings}, allPreparedPieces: [{pieceId, collisionGeometry,
  transforms}], remainingPreparedIds, frozenPlacementOrder,
  frozenGeometryIdentity}`. `settings` is the full `IrregularNestingSettings`
  Effect `Schema.Class` instance passed directly to the encoder — its own
  enumerable instance fields (assigned by the generated Schema.Class
  constructor; verified the class body is empty at `src/shared/irregular/domain.ts:491-496`,
  so all fields come from the schema-driven base constructor) are what
  `Object.entries` sees. `frozenGeometryIdentity` uses
  `canonicalCollisionLayoutIdentity(frozenPlaced) ?? ''` — an **empty-string
  fallback**, not omission, when the frozen seed has no derivable identity
  (e.g. empty `frozenPlaced`).
- **Checkpoint integrity hash** (`intrinsicStrictDirectCheckpointIntegrityHash`,
  `:1058-1078`): `{version, producerRole, requestFingerprint, stateLineage,
  nextPieceIndex, stepTrace, gapFillEvidence, candidateEvaluationCount,
  activeRuntimeMs, phaseLedger}`. `stateLineage` is **not** `checkpoint.state`
  directly — it is the array built by `collectIntrinsicStrictDirectStateLineage`
  (`:1080-1111`), one plain object per ancestor state (walking `.parent`
  pointers), each containing: `pendingIds`, `placedIds`, `unplacedIds`,
  `placementOrder`, `canonicalGeometryIdentity` (empty-string fallback again,
  `:1096`), `canonicalOccupiedGeometryKey`, `translatedCollisionBounds`,
  `sharedCollisionBoundaryLengthMm`, `sharedCollisionBoundaryContactUnits`,
  `nearCompleteStructuralContactCount`,
  `dominantNearCompleteStructuralContactCount`,
  `continuationMetadataIdentity()` (a method call result, `:1106`). This
  means the checkpoint hash is sensitive to the **entire ancestor chain's**
  derived identity, not just the leaf state — a Rust port's `IrregularBeamState`
  equivalent must expose an identical lineage-walk and identical per-ancestor
  field set, in identical order, or the hash will not match even if the leaf
  state is bit-identical.
- `stateLineage` collection **bounds its own length** to `expectedStateCount`
  and detects cycles via a `visited` `Set<IrregularBeamState>` keyed by object
  identity (`:1085-1089`) — returns `undefined` (aborting checkpoint creation
  with a thrown `Error`, `:883-885`, or hash-comparison failure during
  validation, `:943-945`) if the parent chain is cyclic or the wrong length.
  A Rust port's ownership model (likely `Arc<BeamState>` with a `parent:
  Option<Arc<BeamState>>`) cannot form true reference cycles the way a GC'd
  JS object graph theoretically could, but the **length check**
  (`lineage.length === expectedStateCount`) is still semantically required
  and must be preserved as an explicit invariant assertion, not silently
  dropped because "Rust can't have cycles anyway."

### 8.3 SHA-256 usage summary

| Hash | Input | Site |
| --- | --- | --- |
| `requestFingerprint` | canonical JSON of request-shape object | `:1032-1055` |
| `integrityHash` | canonical JSON of checkpoint-shape object + `stateLineage` | `:1062-1077` |
| `canonicalGeometryHash` (terminal, per orientation) | `createHash('sha256').update(canonicalIdentity).digest('hex')` where `canonicalIdentity = canonicalCollisionLayoutIdentity(...)` (**not** run through `intrinsicStrictCanonicalJson** — a plain string from an external function) | `:1811` |
| `canonicalGeometryHash` (completed-metrics) | same pattern | `:1842` |
| `identitySha256` (dead chromosome path) | `createHash('sha256').update(JSON.stringify(pieces.map(...))).digest('hex')` — **plain `JSON.stringify`, not the canonical encoder** | `intrinsicStrictFamilyPortfolio.ts:233-234`, via `chromosomeIdentity` `:433-447` |

Note the asymmetry: the **decoder's own** geometry-identity hashes
(`canonicalGeometryHash`) are SHA-256 over an already-canonical string
produced by `canonicalCollisionLayoutIdentity` (a different file/cluster),
**not** over `intrinsicStrictCanonicalJson` output — only the two
checkpoint/fingerprint hashes in §8.2 go through this cluster's own canonical
encoder. Do not conflate the two encoding paths when porting.

---

## 9. Caches touched and the exact historical access sequence

This cluster does **not** own or directly implement any cache. It touches
exactly two external cache-owning services, always through the same two call
shapes, and the ordering guarantees below are what this cluster contributes
to the overall sequence (the caches' internal validate/lookup/evict/publish
sequencing is owned by `nfpIfpService.ts`/`geometryKernel.ts`, a different
cluster — treat their internals as opaque here).

1. **Per (piece, transform) — geometry transform**: `control.checkpoint('candidate-points')`
   is awaited **first** (`:584`), then
   `geometryKernel.transformCollisionGeometry({geometry, transform})` is
   awaited (`:585-588`). This call happens **exactly once per transform**,
   never memoized or skipped by this cluster itself (any caching is internal
   to `geometryKernel`).
2. **Per (piece, transform), after the first placement only**:
   `nfpIfpService.generatePlacementCandidates({sheet: INTRINSIC_COORDINATE_DOMAIN,
   placed, placedCollisionIndex, moving, settings, candidateDomain:
   'sheetless-nfp', candidateMemoScope, onCandidateProvenance?, control})`
   (`:594-610`). For the very first piece placed into an empty state
   (`state.placedCollisionGeometries.length === 0`), this call is **skipped
   entirely** and replaced by the pure, cache-free `originAnchorCandidates(moving)`
   (`:592-593,1742-1756`) — so the NFP/IFP cache is never touched for the
   first piece of a sheetless construction.
3. **`candidateMemoScope` lifetime**: created **once per
   `constructIntrinsicStrictState` call** (`new IrregularNfpIfpCandidateMemoScope()`,
   `:471`), and the **same instance** is threaded through every
   `generatePlacementCandidates` call for the remainder of that one call
   (every piece, every transform). It is never persisted across
   `constructIntrinsicStrictState` invocations (including across a
   checkpoint resume — a resumed call creates a **new** `candidateMemoScope`,
   since `input.checkpoint` does not carry one). A Rust port's equivalent
   scope object must have exactly this lifetime: one per top-level construct
   call, never shared across calls, including resumes.
4. **`placedCollisionIndex`**: read-only from this cluster's perspective —
   `state.placedCollisionIndex` is passed to `generatePlacementCandidates`
   (`:597`) but never mutated by this cluster; mutation happens inside
   `IrregularBeamState.withPlacement` (a different file).
5. **No other cache is touched by these three files.** In particular,
   `intrinsicGapRegions.ts` performs no caching of its own — every call to
   `deriveCanonicalIntrinsicGapRegions` recomputes the full convex-hull/union/
   difference from scratch (confirmed: no memo map, no module-level cache,
   fresh `PolyTree64` per call, `intrinsicGapRegions.ts:51-52`). This is a
   **duplicate-computation** consideration for Rust performance work (not a
   correctness one): `deriveCanonicalIntrinsicGapRegions(state.placedCollisionGeometries)`
   is called once per piece before the transform loop (`:568`, when
   applicable) **and again** after a gap-fill placement purely for evidence
   accounting (`:760-762`) — i.e., up to twice per piece in the
   `{kind:'gap-contained'}` production role, on the full occupied geometry
   each time, from the same effective inputs modulo the one new placement. A
   Rust port may legally cache/memoize this **as long as** cache hit vs.
   recompute produce byte-identical results (prompt §13.1) and insertion
   race order cannot change output — since the function is pure and
   deterministic given its `placed` array, this is a safe target for a
   job-local memo keyed by the placed-geometry canonical identity, but that
   optimization is not present in the current TypeScript and must be treated
   as a **new** Rust-only cache subject to the full cache-architecture
   discipline of prompt §13, not an emulation of existing TS behavior.

---

## 10. Cancellation / deadline / budget / evaluation-cap observation points

Exact positions, in execution order, within `constructIntrinsicStrictState`
(`intrinsicStrictDecoder.ts:401-866`):

1. **Outer control forwarding + local deadline check**, defined once per call
   as the `control` closure (`:472-488`), but only **evaluated** each time
   `control.checkpoint(phase)` is awaited:
   - First, if the caller supplied an outer `input.control`, its own
     `checkpoint(phase)` is awaited (`:475`) — this can fail with the
     caller's own `IrregularNfpIfpControlAbortError` (`'cancelled'` or
     `'deadline'`, whichever the outer controller decides).
   - Then, unconditionally, the local wall-clock deadline is checked:
     `previousActiveRuntimeMs + timingNow() - startedAt >= maximumRuntimeMs`
     (`:476-479`) — if true, fails with a **local**
     `IrregularNfpIfpControlAbortError({reason: 'deadline', ...})`
     (`:480-486`), always tagged `'deadline'`, never `'cancelled'` (this
     construct has no concept of external cancellation of its own; only the
     outer `input.control`, if present, can signal `'cancelled'`).
   - This combined `control` object is invoked at **exactly one** point in
     this cluster's own code: `yield* control.checkpoint('candidate-points')`
     (`:584`), immediately before `transformCollisionGeometry`, i.e. **once
     per transform**, before geometry work begins for that transform. It is
     **not** re-checked between individual candidates within one transform's
     candidate list, nor between pieces beyond the once-per-transform cadence
     (a piece with only one transform is checked once for that whole piece).
   - The **same** `control` object is also passed into
     `nfpIfpService.generatePlacementCandidates` (`:609`), which internally
     invokes additional checkpoint phases (`'ifp'`, `'placed-nfp'`,
     `'ifp-boundary-intersection'`, `'pairwise-nfp-boundary-intersection'`,
     per `IrregularNfpIfpCheckpointPhase`, `src/workers/irregular/services.ts:78-83`)
     — those are owned by a different cluster; this cluster only guarantees
     that its own `'candidate-points'` checkpoint fires before delegating.
2. **Evaluation cap** (`maximumCandidateEvaluationCount`), checked **inside**
   the per-candidate scoring loop, **before** scoring and **before**
   incrementing the counter: `if (maximumCandidateEvaluationCount !==
   undefined && candidateEvaluationCount >= maximumCandidateEvaluationCount)
   { truncationReason = 'maximum-candidate-evaluations'; break pieceLoop }`
   (`:622-628`). The labeled `break pieceLoop` exits the **entire outer piece
   loop immediately** — not just the current transform's candidate loop, and
   not just the current piece — abandoning any remaining transforms for the
   current piece and any remaining pieces entirely, with **no** `stepTrace`
   entry pushed for the piece being processed when the break fires (the
   `stepTrace.push` at `:728` is unreachable code from this break's
   perspective — it lives after the transform loop, which the `break
   pieceLoop` skips entirely). Consequently: **evaluation-cap truncation
   never produces a resumable direct checkpoint**, because the checkpoint
   block (`:821-841`) is gated on `pauseReason === 'completed-piece-boundary'`,
   which is a wholly different code path (`pauseReason` is never set when
   `truncationReason` is set — they are mutually exclusive by construction,
   both being the only two `break`/loop-exit reasons and each setting only
   its own variable).
3. **Completed-piece-boundary pause** (`maximumCompletedPieceBoundaries`),
   checked **after** a piece's placement decision has been fully committed
   (`state` reassigned) and `completedPieceBoundaries` incremented:
   `if (maximumCompletedPieceBoundaries !== undefined &&
   completedPieceBoundaries >= maximumCompletedPieceBoundaries && pieceIndex +
   1 < input.remainingPreparedPieces.length) { pauseReason =
   'completed-piece-boundary'; break }` (`:808-815`) — the plain (unlabeled)
   `break` here exits only the `pieceLoop` `for` statement itself (equivalent
   to labeled break at this position since it's the loop's own body), which
   is the same effect as the evaluation-cap break in this position, but
   arrives via the **bottom** of a fully-completed iteration, not a
   mid-iteration abort. The `pieceIndex + 1 <
   input.remainingPreparedPieces.length` guard means: **never pause after
   the last piece** — if the piece that just completed was the final one,
   the loop is allowed to finish naturally without producing a spurious
   pause/checkpoint for a construction that is already done.
4. **Checkpoint construction**, gated on `pauseReason ===
   'completed-piece-boundary' && requestFingerprint !== undefined`
   (`:821-824`) — the second condition means checkpointing must have been
   **enabled** at call start (`checkpointingEnabled`, `:431-432`, which is
   true iff `maximumCompletedPieceBoundaries !== undefined || input.checkpoint
   !== undefined`); if `maximumCompletedPieceBoundaries` triggers a pause but
   fingerprinting was somehow not enabled (unreachable in practice, since
   `maximumCompletedPieceBoundaries !== undefined` is exactly one of the two
   conditions for `checkpointingEnabled`), no checkpoint is produced despite
   the pause.
5. **No mid-transform or mid-candidate cancellation exists at all.** Once
   `transformCollisionGeometry` and `generatePlacementCandidates` return for
   one transform, the entire `legalCandidates` array is scored in one
   uninterrupted synchronous(-within-the-Effect-fiber) loop (`:621-667`)
   except for the evaluation-cap break, which is a **budget** check, not a
   **cancellation** check — this cluster provides no way to cooperatively
   cancel mid-candidate-loop for reasons other than the evaluation cap. A
   Rust port introducing finer-grained polling here (e.g. checking an atomic
   cancellation flag every N candidates) would be an **observable chronology
   change** forbidden by prompt §15 unless proven to preserve every accepted
   outcome — do not add polling points that do not exist in the TypeScript
   original.
6. **`finalizeIntrinsicStrictState`** (`:366-398`) and
   `decodeIntrinsicStrictPriorityOrder`'s wrapper (`:331-363`) perform **no**
   additional deadline/cancellation checks of their own; they only consume
   the already-produced `IntrinsicStrictConstructResult`.

---

## 11. Error paths

### 11.1 Tagged error classes originating in or surfaced by this cluster

- `IntrinsicStrictDecoderError` (`intrinsicStrictDecoder.ts:67-70`) — `Data.TaggedError`
  with `{operation: string, message: string}`. Raised at:
  - `:436-438` — seed partition validation failure (`validateSeedPartition`, `:1365-1384`; operation `'seedPartition'`).
  - `:463-469` — direct checkpoint validation failure (`validateIntrinsicStrictDirectCheckpoint`, `:907-1019`; operation `'directCheckpoint'`).
  - `:504-509` — frozen seed forms an illegal canonical layout (operation `'frozenPlaced'`).
  - `:384-389` (in `finalizeIntrinsicStrictState`) — completed canonical layout metrics failed to be finite/exact (operation `'completedMetrics'`); this is the **only** failure path in `finalizeIntrinsicStrictState` itself — all other outcomes (incomplete, infeasible-final-sheet, completed) are `Effect.succeed`, not failures.
  - `:884` — a **thrown JS `Error`** (not an `Effect` failure, not `IntrinsicStrictDecoderError`), inside `makeIntrinsicStrictDirectCheckpoint`, when `collectIntrinsicStrictDirectStateLineage` returns `undefined` for the state about to be checkpointed. This is a genuine synchronous `throw` inside an `Effect.gen` body, which Effect will capture as a **defect** (unrecoverable failure / `Cause.Die`), not as a typed `IntrinsicStrictDecoderError` in the declared error channel. **This is the one place in this cluster where a genuine invariant violation is signaled by a different mechanism (throw/defect) than the rest of the file's typed-error convention** — a Rust port's error enum must include an equivalent "impossible invariant violated" variant that is NOT one of the typed recoverable errors, matching Effect's defect/die semantics (i.e., it should behave like a panic-equivalent contained at the job boundary per prompt §16, not like a normal `Result::Err` the caller is expected to handle).
- Errors this cluster **propagates without wrapping** (declared in its own
  `Effect.Effect<..., ErrorUnion, ...>` signatures but not constructed here):
  `IrregularNestingNotImplementedError`, `IrregularGeometryInputError` (both
  from `geometryKernel`/`services.ts`, surfaced through
  `transformCollisionGeometry`), `IrregularNfpIfpControlAbortError` (from
  either the outer `input.control` or this cluster's own local deadline check,
  §10 item 1).

### 11.2 External `AppErrorCode` mapping (per the governing prompt's table, §16)

This cluster does not itself perform the mapping to `AppErrorCode` — that
happens at the worker/protocol boundary (`src/workers/nesting.worker.ts`,
`src/shared/protocol/errors.ts`), out of scope for these three files. What
this cluster is responsible for is emitting the **correct, stable, typed**
internal error with the correct `operation` context field so that boundary
mapping is possible:
- `IntrinsicStrictDecoderError` does not appear by name in the prompt's
  mapping table (§16); it is presumably subsumed by the general
  `IrregularPortfolioError`/generic-failure handling at a higher layer (out
  of this cluster's file scope — confirm with the caller-side cluster
  covering `intrinsicSharedArchivePortfolio.ts`/`computeIrregularNesting.ts`
  before assuming a specific `AppErrorCode`).
- `IrregularNfpIfpControlAbortError` with `reason: 'cancelled'` maps to
  `worker_cancelled`; `reason: 'deadline'` maps to `worker_timeout` (prompt
  §16 table) — this cluster only ever constructs the `'deadline'` variant
  itself (§10 item 1); a `'cancelled'` instance can only reach this cluster
  from the outer `input.control`, never originate here.

### 11.3 Validation-only failure paths (return a message string, not a thrown error)

Distinct from the `Effect`-channel errors above, several functions return
`string | undefined` (a validation message on failure, `undefined` on
success) rather than raising:
- `validateSeedPartition` (`:1365-1384`) — checks uniqueness of
  `allPreparedPieces`/`remainingPreparedPieces`/`frozenPlaced` IDs, disjointness
  of frozen vs. remaining, and that their union exactly (as a **set**, via
  `.toSorted()` equality, §5 item 15) equals `allPreparedPieces`. Its caller
  (`:434-439`) converts a defined message into an `IntrinsicStrictDecoderError`.
- `validateIntrinsicStrictDirectCheckpoint` (`:907-1019`) — an 11-step
  sequential validation (fingerprint presence → version → producer/fingerprint
  match → `nextPieceIndex` bounds/type → lineage collectibility → integrity
  hash recomputation and comparison → pending-suffix ID match → full lineage
  walk (`validateIntrinsicStrictDirectCheckpointLineage`) → per-step trace
  consistency → evaluation-count/runtime-ledger consistency → phase-ledger
  presence/validity). **Each check is a separate early-return**, so a Rust
  port must replicate the exact check **order** if any test or diagnostic
  depends on which specific message is produced for a given malformed
  checkpoint (the tests do assert on this: see
  `tests/unit/intrinsicStrictDecoder.test.ts:285` "rejects corrupted direct
  state lineage and changed settlement policy").
- `validateIntrinsicStrictDirectCheckpointLineage` (`:1113-1181`) — walks the
  checkpoint's `state.parent` chain exactly `checkpoint.nextPieceIndex` steps,
  validating at each depth: state well-formedness
  (`validateIntrinsicStrictDirectState`, `:1183-1223`), pending-order match,
  accounted-ID-set match (placed ∪ unplaced vs. expected consumed prefix, via
  the set-equality helper `samePieceIdSet`, §5 item 15 — **not** order-sensitive
  here, only set-equality), and a **placed-XOR-unplaced single-step
  transition** check (`:1144-1156`) — exactly one of "placed count grew by
  1 with this piece ID last" or "unplaced count grew by 1 with this piece ID
  last" must hold at each step, otherwise `'direct checkpoint parent lineage
  has an invalid consumed-piece transition.'`. Terminates by requiring the
  root ancestor to exactly reproduce a freshly-anchored frozen-seed state
  (`:1165-1179`, recomputing `new IrregularBeamState({...}).withBottomLeftAnchored()`
  and comparing `canonicalOccupiedGeometryKey`).
- `validateIntrinsicStrictDirectState` (`:1183-1223`) — recomputes a fresh
  `IrregularBeamState` from the checkpoint's own placed/unplaced/order fields
  and requires **four independent recomputed identities** to match the
  checkpointed ones exactly: `canonicalOccupiedGeometryKey`,
  `canonicalEntryContinuationIdentity()`,
  `placedCollisionIndex.continuationIdentity()`, and (separately)
  `placedCollisionIndex.matches(placedCollisionGeometries)`. Any single
  mismatch is a distinct rejection reason.

None of these validation-message functions are `Effect`-based; they are
synchronous pure functions returning `string | undefined`, called from inside
an `Effect.gen` body and converted to a typed failure only at the two call
sites listed in §11.1.

---

## 12. JS-specific semantics hazards for a Rust port

Ranked roughly by concreteness/severity, all specific to this cluster (not a
generic restatement of the governing prompt):

1. **`.localeCompare()` vs. ordinal/byte comparison — the single largest
   hazard in this cluster.** 12 call sites across `intrinsicStrictDecoder.ts`
   (9) and `intrinsicGapRegions.ts` (2) and `intrinsicStrictFamilyPortfolio.ts`
   (1) use `.localeCompare()` as a tie-break, listed exhaustively in §5/§6/§8.
   **Verified empirically in this exact repo's Node runtime** (`node -e`
   against Node with ICU `76.1`): default-locale `.localeCompare()` orders
   punctuation differently from code-unit order — `['12,3','12;3','12-3'].sort((a,b)=>a.localeCompare(b))`
   yields `['12-3','12,3','12;3']` (hyphen before comma before semicolon),
   while ASCII/codepoint order (and Rust's `str::cmp`) gives
   `['12,3','12-3','12;3']` (comma, codes 44/45/59, in numeric order) — a
   **provable divergence** for exactly the alphabet (`,`, `;`, `-`, digits)
   used by `canonicalRing`/`canonicalKey`/`canonicalCombinedGeometryKey`-style
   strings. `.localeCompare()` also orders lowercase before uppercase for the
   same letter (`'a' < 'A'`) in this runtime, opposite of ASCII. **Do not
   assume Rust `str::cmp`/`Ord` matches `.localeCompare()` for any of the 12
   sites.** Recommended path: write a differential test harness comparing
   `String.prototype.localeCompare` (run under the exact Node/Electron/ICU
   version this repo ships, since ICU data and default locale can vary by
   build — `full-icu` vs. built-in `small-icu`) against candidate Rust
   orderings for the actual alphabets in play (SHA-256 hex digests, ring
   canonical keys, geometry keys, JSON object-field names, PieceId strings),
   and if any pair disagrees, implement an explicit locale-emulating
   comparator in Rust rather than relying on `str::cmp`. Do **not** silently
   default to ordinal — that is exactly the "coincidental similarity"
   the governing prompt (§8.1, §9) forbids relying on.
2. **JS `Math.round` ties-toward-`+Infinity` vs. Rust `f64::round()` ties-away-from-zero**
   — proven divergent for negative half-integers (§7.3). Affects
   `canonicalLinearMetric`/`canonicalAreaMetric`, which feed every float-fallback
   comparator branch in this cluster.
3. **`JSON.stringify(NaN | Infinity) === "null"`** silently baked into
   `intrinsicStrictDirectCheckpointIntegrityHash` via real production
   `gapFillEvidence` values (§8.1 hazard 2, §8.2). `serde_json` does not
   replicate this by default and must be explicitly special-cased.
4. **Default `Array.prototype.sort()`/`.toSorted()` (no comparator) is
   ordinal, not locale-aware** — confirmed empirically (§5 item 8) to match
   Rust's natural byte order for the `canonicalRing`/`canonicalCyclicPolygonKey`
   alphabet. This is the "safe" counterpart to hazard 1 — **do not conflate
   the two sort families**: some `.toSorted()` calls in this cluster use no
   comparator (safe, ordinal) and others use `.localeCompare` (unsafe without
   verification) or a numeric comparator (safe, standard IEEE-754 compare).
   A Rust port must track, per call site, which family it belongs to (§5/§6
   enumerate every instance).
5. **JS `Map` insertion-order semantics are load-bearing, not incidental.**
   `candidatesByFamily`/`containedCandidatesByFamily`
   (`intrinsicStrictDecoder.ts:561-565`) and `groupIntrinsicCollisionFamilies`'s
   internal `groups` map (`intrinsicStrictFamilyPortfolio.ts:98`) both rely
   on "first-insertion-position, `.set()` on existing key does not reorder."
   A Rust `HashMap`/`std::collections::HashMap` has no such guarantee and
   uses randomized hashing by default — per the governing prompt (§9), this
   must become an explicit ordered structure (e.g. an insertion-order
   preserving map, or a `Vec` alongside a lookup index) in Rust, never a bare
   hash map relied on for iteration order.
6. **`Object.is(x, -0)` / signed-zero normalization appears in
   `transformFamilyKey`** (`intrinsicStrictDecoder.ts:1758-1762`):
   `Object.is(rotationDeg, -0) ? 0 : rotationDeg` after `% 360` normalization
   — this exists specifically because JS's `%` operator can produce `-0` for
   certain negative-rotation inputs (e.g. `(-360) % 360 === -0`), and without
   this normalization, `` `${-0}:...` `` would stringify as `"0:..."` anyway
   (JS template-literal stringification of `-0` **is** `"0"`, not `"-0"`) —
   so this line is defense against a subtlety that JS's own template-literal
   coercion already neutralizes for the *string* output, but the explicit
   `Object.is` check matters if the family key were ever compared as a raw
   `number` before stringification (it currently is not, in this function).
   Still: a Rust port formatting a rotation `f64` into a family-key string
   must confirm that Rust's `format!("{}", -0.0_f64)` also produces `"0"` (it
   does **not** — Rust prints `-0` for negative zero floats by default) and
   must therefore replicate the `Object.is`-style normalization **before**
   formatting, not rely on formatting to hide it as JS does.
7. **UTF-16 vs. UTF-8 string indexing is not directly exercised by this
   cluster's own logic** (no `.charAt`/`.slice`/`.codePointAt` on
   potentially-non-ASCII content was found in these three files), but every
   string this cluster builds (`canonicalRing`, family keys, canonical JSON)
   is consumed as an opaque comparison/hash key elsewhere, so UTF-16-vs-UTF-8
   byte-length differences are only a risk if a Rust port ever needs a
   byte-identical **string**, not just an equal ordering — confirm with the
   canonical-JSON/hashing cluster whether any downstream consumer assumes
   UTF-16 code-unit lengths.
8. **`for...of` iteration order over arrays** (used throughout, e.g. `:572,621`)
   is simply array index order — no hazard, noted only for completeness since
   the prompt asks about "every iteration order that reaches output."
9. **Closure state**: `scoreCandidate`'s phase-timing mutation via a captured
   object reference (§4.2) is a genuine closure-over-mutable-state pattern
   that has no idiomatic Rust equivalent without an explicit `&mut` parameter
   or interior mutability — straightforward to port, flagged here only so it
   is not missed as "just another pure function" during translation.

---

## 13. Parallelism assessment

### 13.1 Chronology-bound — must stay logically serial

- The **`pieceLoop` itself** (`intrinsicStrictDecoder.ts:551-816`): each
  piece's candidate generation depends on `state.placedCollisionGeometries`
  from the **previous** piece's decision, and the evaluation-cap/pause
  checkpoints (§10) must observe pieces and transforms in the exact existing
  order to reproduce which work happened before a cap/deadline fired. This is
  the textbook "chronology-bound" case from prompt §14.2 ("depth transitions
  before all required ordered results exist").
- The **transform loop within one piece** (`:572-709`): must stay serial
  because (a) `control.checkpoint('candidate-points')` fires once per
  transform and its exact firing order affects deadline-abort timing (§10),
  and (b) `candidatesByFamily`/`containedCandidatesByFamily` insertion order
  across transforms is directly observable in tie resolution (§5 item 3, §12
  hazard 5).
- The **per-candidate scoring loop within one transform** (`:621-667`): must
  stay serial for the same Map-insertion-order reason, **and** because the
  evaluation cap must trip at the exact Nth candidate in this exact order
  (§10 item 2) — parallelizing this loop's *iteration* would change which
  candidate is the "last" one scored before a cap-triggered `break`.
- `orderIntrinsicStrictParetoFront`'s peeling loop (§5 item 11) and
  `rankIntrinsicStrictParetoPartition`'s front-peeling loop (§5 item 12) are
  iterative and each round depends on the previous round's removals — serial
  by construction.

### 13.2 Good Rayon candidates (pure, independent, safe to reduce serially)

- **Per-candidate scoring itself** (`scoreCandidate`, `:1394-1498`, and the
  gap-containment test `candidateContainedInIntrinsicGap` it triggers via
  `:1465-1467`) is a **pure function** of `(state, piece, moving, candidate,
  remainingPreparedPieces, transformFamily, movingCollisionAreaMm2/Grid2,
  gapRegions, timingNow)` with no shared mutable state *except* the optional
  phase-timing accumulator (§4.2), which can be trivially made per-candidate
  and summed serially afterward instead of mutated in place. Per prompt
  §14.3's exact pattern: assign each `(transform, candidate)` pair a stable
  ordinal within the already-known `legalCandidates` array, score in
  parallel, **then** perform the existing serial fold (§5 items 3-4, §6.2)
  over results **in original ordinal order** to reproduce Map-insertion-order
  tie behavior exactly. The evaluation cap (§10 item 2) would need to be
  re-expressed as "score the first `min(remainingBudget, legalCandidates.length)`
  candidates of this transform in parallel, then serially fold and consume
  budget in order, truncating the fold — never the scoring — at the cap" to
  preserve exact truncation semantics; scoring extra candidates that get
  discarded by the serial fold is acceptable **only** if it does not change
  `candidateEvaluationCount` accounting or the identity of the discarding
  point (i.e., the serial fold, not the parallel scoring, must be the sole
  authority for what counts as "evaluated").
- **`deriveCanonicalIntrinsicGapRegions`'s per-piece invocation** (`:568`)
  reads a fixed `state.placedCollisionGeometries` snapshot and produces a
  read-only result consumed by every subsequent transform/candidate in that
  piece — already effectively "compute once per piece" in the existing code;
  no further parallelization opportunity exists *within* one piece's gap-region
  computation without descending into Clipper2 internals (out of this
  cluster's scope).
- **`selectIntrinsicStrictCompletedParetoFront` / `rankIntrinsicStrictCompletedLayouts`'s
  pairwise dominance checks**: the `O(n^2)` `layouts.some(other =>
  intrinsicStrictCompletedLayoutDominates(other, candidate))` inner loop
  (`:2274-2279`, `:2296-2301`) is a pure pairwise comparison over an
  already-fully-known, already-finished list of `IntrinsicStrictCompletedMetrics`
  — an excellent Rayon target (compute the full dominance matrix or
  per-candidate "is dominated" boolean in parallel, indexed by stable
  position in the input array), **followed by** the existing serial
  peeling/ordering logic (§5 items 11-12) applied to the resulting frontier
  set exactly as today.
- **`groupIntrinsicCollisionFamilies`'s key computation**
  (`intrinsicCollisionFamilyKey`, including the `O(n)`-per-piece
  `canonicalCyclicPolygonKey` cyclic-variant enumeration,
  `intrinsicStrictFamilyPortfolio.ts:514-528`) is pure per piece and
  independent across pieces — safe to compute all keys in parallel, indexed
  by original piece position, **then** perform the existing serial
  first-occurrence grouping fold (§5 item 9, §12 hazard 5) over the
  precomputed keys in original order.

### 13.3 Why the caches (§9) constrain parallelism here

`generatePlacementCandidates`/`transformCollisionGeometry` calls happen once
per (piece, transform) in strict sequence in the current code; if a future
Rust port parallelizes across transforms or pieces (which §13.1 forbids for
selection-order reasons regardless), it would also multiply concurrent
pressure on the shared NFP/IFP and geometry caches owned by a different
cluster — any parallelization proposal touching this cluster's transform/piece
loops must be co-designed with that cluster's cache architecture (prompt
§13.3), not decided unilaterally here.

---

## 14. Tests and gates covering this cluster

Grepped `tests/` and `scripts/` for every file that imports from the three
cluster files or their direct dependents (`intrinsicPeriodicCells.ts`,
`intrinsicPeriodicFamilyPortfolio.ts`, `intrinsicSharedArchivePortfolio.ts`)
where relevant to prove liveness (§1.2); the following are the tests that
import the cluster files **directly**:

- `tests/unit/intrinsicStrictDecoder.test.ts` (1560 lines, single top-level
  `describe('decodeIntrinsicStrictPriorityOrder', ...)` at line 147, no
  nested `describe`, ~40 `it` blocks). Also imports
  `intrinsicQueueBeamDiscriminator.ts` (dead-in-prod, `:35-45`) to run
  cross-checks proving the discriminator's experimental audit does not alter
  the strict decoder's own selected geometry (e.g. `:672` "keeps selected
  geometry unchanged when the separate queue-beam audit runs"). Representative
  coverage relevant to this doc's sections: phase-coverage residual thresholds
  (`:148-169`, §"phase timings" not detailed above but present in source),
  exact candidate-evaluation cap (`:170-196`, §10 item 2), full checkpoint
  round-trip through every piece boundary (`:197-284`, §8.2/§10 items 3-4),
  corrupted-checkpoint rejection across every validation branch (`:285-472`,
  §11.3), frozen-seed wrapper equivalence (`:473-615`), F0 observer
  non-interference (`:616-671`), comparator-mode parametrized tests
  (`:1037-1060`, `it.each(['pure-growth','contact-band'])`), origin-anchor
  normalization (`:1061-1072`), family-winner-before-selection preservation
  (`:1073-1110`), exact 2%/1% growth-band boundary (`:1111-1159`, §6.2),
  sub-grid ULP-noise rejection near the exact-grid path (`:1143-1191`),
  authoritative rounded-world envelope after fractional translation
  (`:1192-1222`), contact-vs-growth non-veto Pareto behavior
  (`:1223-1345`, §6.7), Pareto-front-opens-next-layer behavior
  (`:1425-1448`), and exact Clipper path-area measurement across holes and
  quarter turns (`:1449` onward).
- `tests/unit/intrinsicGapRegions.test.ts` (218 lines,
  `describe('intrinsic gap regions', ...)` at line 92): exact hull-gap
  derivation and boundary-touching containment (`:93`), enclosed-cavity vs.
  hull-open-gap distinction (`:114`), real contained-candidate selection with
  non-inert evidence recording (`:129`, exercising the
  `gapFillEvidence`/`nonInert` logic at `intrinsicStrictDecoder.ts:786-799`),
  and contained-candidate retention before same-family growth collapse with
  incremental contact measurement (`:160`).
- `tests/unit/intrinsicStrictFamilyPortfolio.test.ts` (361 lines,
  `describe('intrinsic strict family portfolio', ...)` at line 111): family
  grouping/round-robin (`:112`), size-band interleaving (`:137`),
  large-first-small-fill partitioning (`:154`), repeated-elongated-family
  selection (`:170`), orientation-from-transformed-bounds
  (`:187`, dead-path coverage), invalid/duplicate chromosome recording
  (`:231`, dead-path coverage), Pareto-tradeoff-front starting representative
  (`:259`), and sheet-blind eight-chromosome decode (`:272`, dead-path
  coverage — this specific test exercises `runIntrinsicStrictFamilyPortfolio`,
  which §1.2 establishes is not reachable from production; still an
  important **regression** gate for that code if the orchestrator decides to
  keep it maintained).
- `tests/unit/intrinsicCapacityMode.test.ts`, `intrinsicGlobalSqueezePortfolio.test.ts`,
  `intrinsicReconstructionPortfolio.test.ts`, `intrinsicSharedArchivePortfolio.test.ts`,
  `intrinsicShortSideObserver.test.ts` all import one or more cluster exports
  transitively/directly (grep-confirmed) but are primarily characterizing
  their own modules' integration with this cluster rather than this
  cluster's own behavior — cite them for parity-matrix cross-referencing, not
  as this cluster's primary test suite.
- Developer probe scripts that exercise this cluster but are **not** gates
  (no `pnpm` script wraps them, confirmed by grepping `package.json`):
  `scripts/irregular-intrinsic-strict-probe.ts`,
  `scripts/irregular-intrinsic-family-portfolio-probe.ts`,
  `scripts/irregular-intrinsic-shared-archive.ts`,
  `scripts/irregular-intrinsic-periodic-family-portfolio.ts`,
  `scripts/irregular-intrinsic-periodic-small-fill-e3.ts`,
  `scripts/irregular-intrinsic-global-squeeze-e4.ts`,
  `scripts/irregular-intrinsic-global-triangle-diagnostic.ts`,
  `scripts/irregular-intrinsic-v7-seed-archive.ts`.

### Production gates that exercise this cluster indirectly (via the live call chain in §1.2, not by direct import)

- `pnpm test` (`package.json:26`) runs the full unit suite above.
- `pnpm gate:mixed61-compact` (`package.json:32`) →
  `pnpm corpus:sheet-invariance --case mixed-61 --sheets 2000x2700 --strict
  --expected-canonical-sha256
  ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b
  --maximum-area-mm2 391606 --maximum-canonical-cavities 0
  --maximum-elapsed-ms 330000` — this expected hash matches the value cited
  in the governing migration prompt §18.6, and the Compact production path
  that produces it runs through this cluster's `constructIntrinsicStrictState`/
  `evaluateIntrinsicStrictCertificate`/`rankIntrinsicStrictCompletedLayouts`
  for the `'canonical-grid'`, `'legacy-absolute-envelope'`, and
  `'open-pocket-first'` direct roles (§1.2), plus `groupIntrinsicCollisionFamilies`
  via the periodic-family stage. **This gate is a de facto end-to-end parity
  gate for this cluster's exact numeric/comparator/hashing behavior** even
  though it never imports these files by name.
- `pnpm gate:compact-nine-baselines`, `pnpm gate:capacity`,
  `pnpm gate:capacity:production` (`package.json:33-35`) similarly exercise
  this cluster indirectly through the same production call chain.

---

## 15. Open questions and ambiguities

1. **Scope discrepancy against the governing migration prompt's file list.**
   The prompt (§5, "Complete Compact construction") lists
   `intrinsicStrictFamilyPortfolio.ts` alongside `intrinsicStrictDecoder.ts`
   and `intrinsicGapRegions.ts` as an "important file" for Compact
   construction, with no qualification. §1.2/§2.3 of this document show that
   only `groupIntrinsicCollisionFamilies` (plus its two private helper
   dependencies) is actually reachable from `computeIrregularNesting.ts`;
   the four-order × two-template chromosome-portfolio machinery
   (`buildIntrinsicFamilyPortfolioChromosomes`, `runIntrinsicStrictFamilyPortfolio`,
   `selectIntrinsicFamilyPortfolioWinner`, `orderIntrinsicFamilyPortfolioPieces`,
   `selectRepeatedElongatedFamilies`, `sizeBands`, `familyRoundRobin`,
   `restrictOrientationTemplate`) is reachable only from developer probe
   scripts and its own unit test, never from the production algorithm.
   **The orchestrator must decide and record explicitly**: does the Rust
   Stage 2 one-thread-parity obligation include this dead code (because the
   prompt names the file) or exclude it (because prompt §1 scopes the
   objective to "the complete irregular polygon algorithm for these two
   production profiles," and dead code is not part of any profile's
   execution)? This document recommends: exclude the chromosome-portfolio
   functions from the Rust port's *parity-gated* surface, but flag this
   explicitly in the parity matrix as "intentionally not ported; TypeScript
   remains the only implementation" rather than silently omitting it,
   because prompt §4.1 requires "the existing irregular TypeScript
   implementation as a maintained reference backend" to remain available
   regardless — TypeScript keeps this code either way, and only the Rust
   port's scope is in question.
2. **`.localeCompare()` locale/ICU dependency is environment-sensitive and
   not pinned by this repo in any way I could find** (§12 hazard 1) — no
   `full-icu` dependency, no `NODE_ICU_DATA` in `package.json`/`.npmrc`/
   `electron-builder` config (grepped, zero hits). Node's built-in
   "small-icu" typically still provides full `Intl.Collator`/`localeCompare`
   behavior for the default locale via bundled ICU data (verified `icu`
   version `76.1` in this sandbox's Node), but the **exact collation table**
   is an ICU-version-pinned artifact, not a JS-language guarantee. If the
   Electron-bundled V8/ICU version differs from the Node version used in
   tests/CI, `.localeCompare()` results **could** differ between test runs
   and packaged-app runs even without any Rust involvement. **Open question
   for the orchestrator**: should Stage 0/1 add an explicit test asserting
   `.localeCompare()` output for the specific alphabets this cluster uses is
   stable across the Node version used in CI and the Electron version used in
   production, before a Rust locale-emulation strategy is chosen? Without
   that, "match TypeScript's `.localeCompare()`" is itself a moving target.
3. **`exactStrictRelativeDeficit`'s hand-duplicated threshold literals**
   (§6.8, `intrinsicStrictDecoder.ts:2064-2087`) are not derived from
   `INTRINSIC_STRICT_COHESION_FLOORS` (`:60-65`) at the source level — they
   are independently hardcoded BigInt-friendly forms of the same four
   thresholds (`2`, `4/5`, `3/20`). Should the Rust port introduce a single
   source of truth (e.g. derive the exact-fraction thresholds from the same
   constant table at compile time) as a **provably-equivalent** refactor
   (permitted under prompt §2's "unless you can prove that it is completely
   unobservable"), or must it preserve the literal duplication verbatim with
   a cross-check unit test pinning both representations to the current
   values? This document takes no position; it flags the duplication as a
   fact the orchestrator must decide on.
4. **`CanonicalIntrinsicGapRegion.aabb` is computed in grid units, not
   millimeters** (§3.7) and has no reader within these three files. Is it
   consumed elsewhere (a different cluster) in a way that assumes grid units,
   or is it genuinely dead data that a Rust port could theoretically drop
   from the *hot* struct (while still computing it if any external contract,
   e.g. a replay/serialization schema, requires the field to exist)? Needs
   confirmation from whichever cluster covers `IrregularPortfolioResult`/
   replay serialization before deciding whether `aabb` must be ported at
   all, and if so, in which units.
5. **The one genuine `throw` inside `Effect.gen`** (`intrinsicStrictDecoder.ts:884`,
   §11.1) has no test in `tests/unit/intrinsicStrictDecoder.test.ts` that
   specifically exercises the `collectIntrinsicStrictDirectStateLineage`
   returning `undefined` for a **freshly-produced** (not externally-supplied)
   checkpoint — the corrupted-checkpoint tests (`:285` onward) exercise the
   `validateIntrinsicStrictDirectCheckpoint` path (a different function),
   not `makeIntrinsicStrictDirectCheckpoint`'s own defensive throw. Is this
   throw actually reachable under any real input, or is it unreachable
   defensive code (in which case a Rust port's "impossible invariant"
   handling for it can be a simple `unreachable!()`-with-context rather than
   a carefully tested error path)? This should be resolved with a targeted
   property/fuzz test before the orchestrator decides how much rigor the
   Rust equivalent needs here.
6. **Whether `deriveCanonicalIntrinsicGapRegions`'s current double-computation
   per piece** (§9 item 5 — once for candidate filtering, once again for
   post-placement evidence accounting) is intentional or an accepted
   inefficiency. The migration prompt treats "current behavior IS the spec"
   as absolute, so a Rust port must reproduce this double computation exactly
   for parity — but §13.2/§9 identify it as a safe, pure, job-local
   memoization target for a **performance-only** Rust optimization (same
   inputs → same outputs, no ordering dependency). The orchestrator should
   explicitly record that this specific optimization is **allowed** under
   prompt §2 ("only accepted production improvement is execution time")
   before a Rust implementer spends effort deduplicating it, since it is not
   obviously in scope without that confirmation (it changes which underlying
   Clipper2 calls happen, even though it cannot change any observable
   output).
