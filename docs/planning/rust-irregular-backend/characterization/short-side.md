# Characterization: Compact Short Side cluster

Stage 0 characterization for the Rust irregular-nesting port. Scope is exactly
the four files assigned to the `short-side` cluster:

- `src/workers/algorithm/irregular/intrinsicShortSideAxes.ts` (34 lines)
- `src/workers/algorithm/irregular/intrinsicShortSideObserver.ts` (775 lines)
- `src/workers/algorithm/irregular/intrinsicShortSidePairFoldObserver.ts` (1677 lines)
- `src/workers/algorithm/irregular/intrinsicShortSideContactStrip.ts` (845 lines)

All four files were read in full. Every claim below cites `file:line`. Line
numbers are from the current `main` checkout, commit `f282f0a` (see `git log
-1`); §15 records the exact chronology of behavior-changing commits that made
two widely-documented parts of the historical prose stale.

The TypeScript behavior described here — including behavior that looks
inconsistent with its own doc comments — is the specification. Nothing in
this document proposes a behavior change.

## 1. Purpose and role in Compact / Compact Short Side execution

Compact Short Side ("Short Side", `intrinsicObjectiveProfileId: 'short-side'`)
is a **directional-only** sibling profile. Its production contract (verified
against source, not docs — see §15):

1. Ordinary Compact/capacity search settles first and produces the normal
   placed/unplaced piece-ID partition, exactly as for the `'compact'` profile.
2. Short Side receives that settled partition (only the **placed** target IDs)
   and independently constructs new directional geometry for exactly those
   IDs.
3. There is **no Compact-geometry fallback**. If no legal directional
   construction can be built for the full target set, the whole request fails
   with `IrregularNoValidResultError` → external code `irregular_no_valid_result`
   (`src/workers/algorithm/irregular/computeIrregularNesting.ts:1194-1200`, mapped at
   `src/workers/nesting.worker.ts:440-443`).

Live-in-production status of each of the four files, traced by caller, not
assumed:

| File | Live on production Short Side path? | Evidence |
| --- | --- | --- |
| `intrinsicShortSideAxes.ts` | **Yes.** `intrinsicShortSideAxes`/`intrinsicShortSideSpan` are called from both other production modules and from the production gate script. | called at `intrinsicShortSideObserver.ts:148,321,498,606`, `intrinsicShortSidePairFoldObserver.ts:321,1206,1498,1545,1606`, and from `scripts/irregular-compact-nine-baselines.ts:6-8,525-527` |
| `intrinsicShortSideObserver.ts` (`observeIntrinsicShortSideOrientations`) | **Partially live, but its ranked "winner" is dead for output selection.** It is called unconditionally whenever the Short Side profile is requested (`computeIrregularNesting.ts:1085-1090`) and its `productionShortAxisSpanMm/…Grid` fields *are* consumed downstream (see below). Its own ranked archive endpoint (`observerWinnerCanonicalGeometryHash`/`observerWinnerRotationDeg`) is **never** used to select the returned layout — see §15, finding 1. | `computeIrregularNesting.ts:1091-1122` only feeds the winner to a benchmark hook (`onIntrinsicShortSideObserverWinner`), never to `selected` |
| `intrinsicShortSidePairFoldObserver.ts` (`observeIntrinsicShortSidePairFold`) | **Yes, fully authoritative.** Its accepted outcome, and only its accepted outcome, is materialized as the Short Side result (`computeIrregularNesting.ts:1170-1192`). | `computeIrregularNesting.ts:1149-1192` |
| `intrinsicShortSideContactStrip.ts` (`constructIntrinsicShortSideContactStrip`) | **Yes.** Called three-to-five times per Short Side request from inside `observeIntrinsicShortSidePairFold` (depth-first lane, contact-first lane, and up to two small-target order continuations). | `intrinsicShortSidePairFoldObserver.ts:524-550` (depth-first), `:580-610` (contact-first), `:663-689` (continuations) |

Entry gating: this entire cluster runs only when
`settledCompleteArchiveForShortSideObserver !== undefined` **and**
(`shortSideProfileRequested` or a benchmark capture flag/hook is set)
(`computeIrregularNesting.ts:1071-1076`). `shortSideProfileRequested` is
`input.settings.optimizer.intrinsicObjectiveProfileId === 'short-side'`
(`computeIrregularNesting.ts:484-485`), a real, schema-validated,
renderer-settable production option (`src/renderer/components/IrregularSettingsPanel.vue:111`,
`src/shared/irregular/defaults.ts:172`, `src/shared/irregular/domain.ts:325,436-450`).
The schema additionally requires the shared archive enabled and GA disabled
for the Short Side profile (`src/shared/irregular/domain.ts:436-450`).

`settledCompleteArchiveForShortSideObserver` is assigned exactly once, from
the **ranked, deduplicated, sheetless** complete archive
(`sheetlessArchive = retainRankedSharedArchive([...protectedSheetlessArchive,
...focusedReconstructionEndpoints])`, `computeIrregularNesting.ts:934-938`).
This happens on the "complete archive present" branch of Compact's own
coordinator; it is **not** reassigned on the "no archive eligible / straight
capacity search" branch (`computeIrregularNesting.ts:1065-1069`), so on that
branch `settledCompleteArchiveForShortSideObserver` stays `undefined` and the
whole Short Side cluster is skipped even if the Short Side profile was
requested — the request then returns the plain capacity result unchanged.
This is a real, source-verified branch and is worth a dedicated Rust parity
test (see §15 open question).

## 2. Entry points, callers, callees (traced, not guessed)

### 2.1 Call graph into the cluster

```
computeIrregularNesting.ts: coordinateIntrinsicSharedArchive()
  -> observeIntrinsicShortSideOrientations()          [intrinsicShortSideObserver.ts:140]
       -> intrinsicShortSideAxes()                     [intrinsicShortSideAxes.ts:15]
       -> directionalReference() -> IrregularBeamState.withQuarterTurnBottomLeft()
       -> observeEndpoint() -> observeOrientation() (x2 per endpoint, q0/q90)
       -> cavityHullGuardEligible(), compareEndpointObservations() (Pareto rank)
  -> observeIntrinsicShortSidePairFold()               [intrinsicShortSidePairFoldObserver.ts:240]
       -> constructPairFold() (Effect.gen)
            -> geometryKernel.transformCollisionGeometry()  (per piece x per transform)
            -> constructPairLayout() / constructNextFitShelf()
            -> finalizePlacedLayout() -> finalizeOutcome()
                 -> measureCanonicalLayoutTopologyExact(), measureCanonicalLayoutContacts(),
                    canonicalCollisionLayoutIdentity(), assertCanonicalGridLegalLayout()
                    [all from ../../irregular/canonicalLayoutGeometry.ts]
            -> constructIntrinsicShortSideContactStrip()  (depth-first, contact-first, +2 continuations)
                 [intrinsicShortSideContactStrip.ts:171]
                 -> nfpIfpService.generatePlacementCandidates()  [../../irregular/services.ts]
                 -> hasPositiveCanonicalGridBoundaryContact(),
                    measureCanonicalGridBoundaryOverlapAxisUnits()
                    [../../irregular/canonicalGridContact.ts]
            -> selectDirectionalIncumbent() (final winner among pair-fold/shelf vs. strips)
```

### 2.2 Direct production caller

`src/workers/algorithm/irregular/computeIrregularNesting.ts` is the only
production caller of any of these four files
(`grep -rln` over `src/` confirms this — no other production module imports
`intrinsicShortSideAxes.ts`, `intrinsicShortSideObserver.ts`,
`intrinsicShortSidePairFoldObserver.ts`, or `intrinsicShortSideContactStrip.ts`).
`computeIrregularNesting.ts` is invoked from
`src/workers/nesting.worker.ts:377`. Its result flows through
`makeIrregularWorkerOutput` (`src/workers/algorithm/irregular/irregularWorkerOutput.ts:88`),
which does **not** read `intrinsicShortSideObserverTrace` or
`intrinsicShortSidePairFoldTrace` by name (verified by grep over that file) —
so those two trace objects never reach the Electron protocol result, saved
sub-run settings, or persisted history. They are attached to the
`IrregularComputeResult` object only (`computeIrregularNesting.ts:1232-1237`)
and are read only by: `scripts/irregular-compact-baseline.ts`,
`scripts/irregular-compact-nine-baselines.ts`, and
`tests/unit/intrinsicCapacityIntegration.test.ts` (all confirmed by grep).
Non-production benchmark hooks (`onIntrinsicShortSideObserver`,
`onIntrinsicShortSideObserverWinner`, `onIntrinsicShortSidePairFoldObserverWinner`,
`captureIntrinsicShortSideObserver`, `captureIntrinsicShortSidePairFoldObserver`)
are declared on `ComputeIrregularNestingOptions`
(`computeIrregularNesting.ts:164-182`) and are wired only from tests/scripts.

### 2.3 Callees outside the cluster (own their own semantics; not re-derived here)

- `../../irregular/canonicalLayoutGeometry.ts` — `assertCanonicalGridLegalLayout`,
  `canonicalCollisionLayoutIdentity`, `measureCanonicalLayoutTopologyExact`,
  `measureCanonicalLayoutContacts`, `placedCollisionWorldGridPath`. Read enough
  to characterize inputs/outputs (§3, §7) but its full internals belong to a
  different characterization cluster.
- `../../irregular/canonicalGridContact.ts` — `hasPositiveCanonicalGridBoundaryContact`,
  `measureCanonicalGridBoundaryOverlapAxisUnits`, `measureCanonicalGridBoundaryContact`.
  Read in full because the exact contact tuple is this cluster's special focus (§6).
- `../../irregular/canonicalGridMath.ts` — `compareBigInts`, `compareCanonicalGridRatios`,
  `canonicalGridCrossSign`. Read in full (small file).
- `../../irregular/clipper2OffsetPolicy.ts` — `toGridMm`, `fromGrid`. Read in full
  (small file); this is the float↔grid conversion boundary (§7).
- `irregularBeamState.ts` — `IrregularBeamState`, in particular
  `withQuarterTurnBottomLeft` (line 379) and `withBottomLeftAnchored` (line 287).
  Read the relevant methods in full; the rest of the 986-line file belongs to a
  different cluster.
- `intrinsicStrictDecoder.ts` — `INTRINSIC_STRICT_COHESION_FLOORS` (line 60),
  `intrinsicStrictCompletedLayoutDominates` (line 2263) and its dependency
  `compareIntrinsicStrictCompletedLayoutDominance` (line 2248), which in turn
  depends on `intrinsicStrictGeometricObjectives`, an array defined elsewhere in
  that 2363-line file and **not** re-derived here — it belongs to the Compact
  complete-construction cluster.
- `intrinsicSharedArchivePortfolio.ts` — `IntrinsicSharedArchiveEndpoint` type
  (line 73) and `retainRankedSharedArchive` (line 355), which determines the
  incoming order of `endpoints` (§5).
- `../../irregular/services.ts` — `NfpIfpService.generatePlacementCandidates`,
  `IrregularNfpIfpControlAbortError` (line 70). The candidate generator itself
  is out of scope for this cluster; only its call contract and error type are
  used here.
- `GeometryKernel.transformCollisionGeometry` — used to materialize per-transform
  collision geometry; out of scope.

## 3. Data in/out: exact types/shapes, optional-field presence/omission semantics

### 3.1 `intrinsicShortSideAxes.ts`

`intrinsicShortSideAxes(sheet: {width, height}) -> IntrinsicShortSideAxes`
(`intrinsicShortSideAxes.ts:15-27`):

```
shortAxisIsWidth = sheet.width < sheet.height   // strict <, so width === height => false
shortAxis:  shortAxisIsWidth ? 'width' : 'height'
longAxis:   shortAxisIsWidth ? 'height' : 'width'
shortAxisMm: shortAxisIsWidth ? sheet.width : sheet.height
longAxisMm:  shortAxisIsWidth ? sheet.height : sheet.width
normalizedToPhysicalRotationDeg: shortAxisIsWidth ? 0 : 90
```

**Square-sheet rule (special focus item):** because the comparison is strict
`<`, a square sheet (`width === height`) always takes the `false` branch:
`shortAxis = 'height'`, `longAxis = 'width'`, `normalizedToPhysicalRotationDeg
= 90`. Combined with the 90° quarter-turn semantics of
`IrregularBeamState.withQuarterTurnBottomLeft` (`irregularBeamState.ts:475-489`,
which maps `(x,y) -> (-y, x)`), this is exactly the "on square sheets physical
Y is short axis, physical X is long axis" rule: Short Side always constructs
internally in normalized coordinates where `x` is the short axis and `y` is
the long axis (documented at `intrinsicShortSideContactStrip.ts:160-169`), then
applies this prescribed rotation once at the end
(`intrinsicShortSidePairFoldObserver.ts:1206-1208`) to map back to the
sheet's physical width/height axes. For a non-square sheet with `width <
height`, rotation is 0 (no-op) and internal x/y already equal physical
width/height. For `width > height`, rotation is 90° regardless of squareness.

`intrinsicShortSideSpan(axes, dimensions) -> number` (`intrinsicShortSideAxes.ts:29-34`)
picks `dimensions.width` or `dimensions.height` by `axes.shortAxis`.

### 3.2 `intrinsicShortSideObserver.ts`

Input to `observeIntrinsicShortSideOrientations` (`:140-145`):
`{ sheet: SheetSpec; endpoints: ReadonlyArray<IntrinsicSharedArchiveEndpoint>;
productionPlacedCollisionGeometries?: ReadonlyArray<IrregularPlacedPiece>; now?:
() => number }`. In production, `endpoints` is the ranked sheetless archive
(§1) and `productionPlacedCollisionGeometries` is the final settled Compact/capacity
`selected.placedCollisionGeometries` (`computeIrregularNesting.ts:1085-1090`).
If `productionPlacedCollisionGeometries` is omitted, it falls back to
`input.endpoints[0]?.placedCollisionGeometries ?? []` (`:155-159`) — never
exercised in production because the caller always supplies it.

Output `IntrinsicShortSideObserverTrace` (`:108-137`) — every optional-typed
field (`string | undefined`, `number | undefined`) is present as a JS key with
literal value `undefined` when unset (plain object literal, not a
`declare`/`hasOwnProperty` class), so `JSON.stringify` **drops** those keys
(standard JS `JSON.stringify` behavior for `undefined` values), which matters
for the byte-size self-measurement in §8/§9. `rankedCanonicalGeometryHashes`
is always an array (never omitted, can be empty). `outputInfluence` is **always**
`'none'` in the object actually returned by this function — see §15 finding 1.

### 3.3 `intrinsicShortSidePairFoldObserver.ts`

Input to `observeIntrinsicShortSidePairFold` (`:240-251`): `sheet`,
`preparedPieces: ReadonlyArray<IrregularPreparedPiece>` (already filtered by
the caller to the Compact-selected placed target IDs,
`computeIrregularNesting.ts:1141-1148`), `settings`, six `production*` scalars
(`productionShortAxisSpanMm/Grid`, `productionMaximumSideMm/Grid`,
`productionEnvelopeAreaMm2/Grid2`) sourced from `intrinsicShortSideObserver.ts`'s
`directionalReference` computation, and an optional `runtimeControl` (injectable
clock/RSS sampler for tests).

Output: `Effect<IntrinsicShortSidePairFoldOutcome, never, GeometryKernel |
NfpIfpService>` — **the Effect's error channel is `never`.** All internal
`IrregularGeometryInputError` / `IrregularNestingNotImplementedError` failures
are caught inside this function (`:275-303`) and converted into a normal
(non-error) outcome with `status: 'failed-protected-fallback'`. See §11 for
why this is a real divergence from the module-agnostic error-mapping table.

`IntrinsicShortSidePairFoldOutcome = { trace: IntrinsicShortSidePairFoldTrace;
placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece> | undefined }`
(`:187-190`). `placedCollisionGeometries` is defined **iff**
`trace.status === 'accepted'` (`:1464-1467`; every other status path passes
`placedCollisionGeometries: undefined`, e.g. `:1650`).

### 3.4 `intrinsicShortSideContactStrip.ts`

Input (`:171-177`): `stripSheet: SheetSpec` (constructed by the caller with
`width = requestedShortAxisMm`, `height = axes.longAxisMm`,
`intrinsicShortSidePairFoldObserver.ts:525-529`), `preparedPieces`, `settings`,
optional `selectionPolicy: 'depth-first' | 'contact-first'` (default
`'depth-first'`), optional `orderPolicy: 'prepared' | 'reverse' |
'piece-id-ascending'` (default `'prepared'`; **only used as a trace label** —
the actual piece order comes from `input.preparedPieces` itself, which the
caller reorders before calling), optional `runtimeControl` including
`maximumCandidateEvaluations`, `maximumBacktracks` (both default
`Number.POSITIVE_INFINITY`, `:200-204`), and `tieEvidenceSink` (test-only hook,
`:86`, invoked at `:390-392`).

Output: `Effect<IntrinsicShortSideContactStripOutcome, never, GeometryKernel |
NfpIfpService>` — same never-fails contract as §3.3, same catch-and-convert
pattern (`:208-229`).

## 4. Algorithm state and every mutation point

### 4.1 `intrinsicShortSideObserver.ts`

Pure/functional. No mutable state beyond local `let` bindings inside
`observeIntrinsicShortSideOrientations`. All derived collections (`observedEndpoints`,
`legalEndpoints`, `guardEligibleEndpoints`, `geometricParetoEndpoints`,
`geometricParetoIndexes` (a `Set`, used only for O(1) membership lookup, not
iterated — safe), `endpoints`, `ranked`) are fresh arrays built with
`.map`/`.filter`/`.toSorted` (`:161-217`). `toSorted` is the copying,
non-mutating variant (ES2023) — the input array is never mutated.

### 4.2 `intrinsicShortSidePairFoldObserver.ts`

`ObserverRuntime` (`:192-206`) is a single mutable record threaded by
reference through the whole construction: `peakRssBytes`,
`transformEvaluations`, `expectedPairCount`, `evaluatedPairCount`,
`envelopeAreaCostVetoObserved`, `envelopeAreaCostVetoes` (array, mutated via
`.push`, `:1404-1407`). Mutation points:

- `runtime.transformEvaluations += 1` once per `(piece, transform)` pair
  during pair/shelf transform selection (`:341`).
- `runtime.expectedPairCount = n*(n-1)/2` once (`:400`).
- `runtime.evaluatedPairCount += 1` once per unordered pair examined (`:439`).
- `runtime.envelopeAreaCostVetoObserved = true` and
  `runtime.envelopeAreaCostVetoes.push(...)` inside `finalizeOutcome`, only
  when `!envelopeAreaCostWithinProductionBound && admittedBesidesAreaCost`
  (`:1402-1408`) — this is evidence-only, not a control-flow gate (§11, §15).
- `runtime.peakRssBytes = Math.max(runtime.peakRssBytes, runtime.currentRssBytes())`
  inside `sampleRss` (`:1581-1584`), called from `boundedStatus` and directly
  before emitting a trace.

`selectedTransforms`/`shelfTransforms` (local mutable arrays, `:335-336`) are
built once per call by iterating `input.preparedPieces` in order and pushing
the best transform per piece (`:396-397`) — no re-ordering after push.

`placed: IrregularPlacedPiece[]` inside `constructPairLayout` (`:1095`) and
`constructNextFitShelf` (`:1126`) are local, freshly built per call.

### 4.3 `intrinsicShortSideContactStrip.ts`

`StripRuntime` (`:117-132`) mirrors the pair-fold runtime shape:
`transformEvaluations`, `candidateEvaluations`, `placedCount`,
`backtrackCount`, `reusedPrefixPlacements`, `peakRssBytes`. Mutation points:

- `runtime.transformEvaluations += 1` once per `(piece, transform)` (`:274`).
- `runtime.candidateEvaluations += 1` once per raw NFP/IFP candidate emitted
  by `generatePlacementCandidates`, **before** the evaluation-cap check that
  can abort mid-loop (`:310-322`) — the cap can therefore trip in the middle
  of one piece's candidate list.
- `runtime.backtrackCount += 1` and `runtime.reusedPrefixPlacements +=
  checkpoint.placedBefore.length` on every checkpoint pop-and-resume
  (`:373-374`).
- `runtime.placedCount = placed.length` after every successful placement or
  backtrack resume (`:375`, `:410`).

Loop-local mutable state inside `constructStrip` (`:243-447`):
`placed: IrregularPlacedPiece[]` (rebuilt wholesale on backtrack:
`placed = [...checkpoint.placedBefore, checkpoint.baselinePiece]`, `:369`, not
mutated in place — this is a fresh array assignment, so the previous
`placed` reference the checkpoint may still hold (`checkpoint.placedBefore`)
is never retroactively mutated); `placedCollisionIndex:
PlacedCollisionSpatialIndex` (an immutable/persistent structure — `.add(piece)`
returns a new index, `:411`, `:370-372` — no in-place spatial-index mutation);
`checkpoints: ContactDecisionCheckpoint[]` (push on `:399-407`, pop on
`:357`, i.e. a genuine last-in-first-out stack — order matters, see §5);
`pieceIndex` (advances `+= 1` on normal placement `:412`, or jumps to
`checkpoint.pieceIndex + 1` on backtrack `:376`, which can move it **backward**
relative to where the failure occurred).

## 5. Ordering sources: sorts, Map/Set insertion order, iteration order reaching output

Every sort in this cluster uses `.toSorted(comparator)` (copying) or
`Array.prototype.sort` (in-place, on a freshly spread copy) — **JS sort
stability (ES2019+) is relied upon** wherever the comparator can return `0`
(ties). All comparators below are total-order-except-final-hash/index
tie-breakers, so stability mostly only matters when even the final tie-break
(hash or index) is equal, which should not occur for distinct inputs but is a
correctness precondition a Rust port must reproduce with an explicit stable
sort (e.g. attach original index and compare it last, or use a proven-stable
sort routine) rather than relying on `slice::sort_unstable` semantics.

1. `ranked = endpoints.filter(...).toSorted(compareEndpointObservations)`
   (`intrinsicShortSideObserver.ts:197-199`) — best-first ranking of Pareto-
   eligible endpoint observations. `compareEndpointObservations` ends in
   `first.archiveIndex - second.archiveIndex` (`:615`), so ties are broken by
   the **input archive order**, which itself is already the Compact-side
   dominance ranking (`retainRankedSharedArchive`,
   `intrinsicSharedArchivePortfolio.ts:355-379`, which sorts via
   `rankIntrinsicStrictCompletedLayouts`, out of this cluster's scope). Because
   the tie-break is a numeric index difference, this branch is a genuine total
   order and stability is not actually load-bearing here — but the Rust port
   must still reproduce `archiveIndex` assignment order (`input.endpoints.map(
   (endpoint, archiveIndex) => ...)`, `:161-169` — plain array index, 0-based,
   in caller order).
2. `orientations.toSorted((a,b) => second.usedShortAxisSpanGrid -
   first.usedShortAxisSpanGrid || first.usedLongAxisSpanGrid -
   second.usedLongAxisSpanGrid)[0]` inside `directionalReference`
   (`intrinsicShortSideObserver.ts:553-557`) — picks the better of the (at
   most two) q0/q90 production orientations; input array has at most 2
   elements built by iterating `([0, 90] as const)` in that literal order
   (`:507`), so this sort is effectively "pick max of 2", tie-break by shorter
   long-axis span; a genuine tie here (identical span pair from both
   rotations) falls through to whichever the stable sort places first, which
   for a 2-element array with sort key equal is **the original relative
   order**, i.e. q0 before q90 (order of the `flatMap` source, `:507`).
3. `sortByPieceId` (`intrinsicShortSidePairFoldObserver.ts:803-811`) — `[...pieces].sort((a,b)
   => firstId < secondId ? -1 : firstId > secondId ? 1 : 0)`, a plain
   JS-string `<`/`>` comparison (UTF-16 code-unit order, **not**
   `localeCompare`), used only for the `'piece-id-ascending'` order
   continuation (`:650-652`).
4. `input.preparedPieces.toReversed()` (`intrinsicShortSidePairFoldObserver.ts:647`)
   — a plain reversal (ES2023 `toReversed`), used for the `'reverse'` order
   continuation.
5. `intervals...toSorted((a,b) => first.start - second.start)` inside
   `shortAxisProjectionMetrics` (`intrinsicShortSidePairFoldObserver.ts:1549`) —
   sorts short-axis-projected intervals for the interval-merge coverage
   computation (evidence only, not used by `accepted`, see §15).

Map/Set usage, none of which is iterated for output (all lookup-only, so
JS insertion-order guarantees are not actually load-bearing, but flagged for
completeness):

- `geometricParetoIndexes = new Set(...)` (`intrinsicShortSideObserver.ts:189-191`)
  — membership test only (`.has`), never iterated.
- `expectedPieceIdSet`, `placedPieceIdSet` (`intrinsicShortSidePairFoldObserver.ts:1357-1358`)
  — `.size` and `.has` only.

Contact-strip candidate/checkpoint order (this is the one place where
insertion order genuinely reaches the selected output):

- `checkpoints: ContactDecisionCheckpoint[]` used as a **stack**
  (`intrinsicShortSideContactStrip.ts:248`, push `:399-407`, pop `:357`) — LIFO
  order is semantically load-bearing: the most recently made "selection
  changed" decision is the first one rolled back on a dead end.
- `anchoredCandidates: AnchoredCandidate[]` built by iterating
  `piece.transforms` in array order, and within each transform, iterating
  `candidates` (the array returned by `nfpIfpService.generatePlacementCandidates`,
  owned by a different cluster) in its emitted order (`:272-336`). This order
  never itself decides the winner (the winner is chosen by an explicit
  comparator, `compareAnchoredCandidates`, §6), **except** in the literal
  tie case where two anchored candidates compare exactly equal by every field
  in that comparator — then whichever was inserted first remains the
  `baseline`/`winner` because the comparisons are strict `<` (`:379, 382,
  553, 636` in the two source files use `< 0`, never `<= 0`, so first-seen
  wins ties). This means **transform emission order and NFP/IFP candidate
  emission order are load-bearing tie-break inputs** for a Rust port, even
  though both are produced outside this cluster.

## 6. Comparators and tie rules: exact comparison chains, signs, tie-breakers

### 6.1 `compareEndpointObservations` (`intrinsicShortSideObserver.ts:608-617`)

```
compareOrientationObservations(first.selected, second.selected)
  || first.canonicalGeometryHash.localeCompare(second.canonicalGeometryHash)
  || first.archiveIndex - second.archiveIndex
```

`canonicalGeometryHash` here is `IntrinsicSharedArchiveEndpoint.sheetlessCanonicalGeometryHash`
(a hex SHA-256 string), so `.localeCompare` on hex-ASCII strings is
locale-dependent in principle but should equal ASCII/byte order for a
`[0-9a-f]` alphabet under the default (`undefined`) locale in V8 — still a JS
hazard to reproduce byte-for-byte in Rust (§12), not necessarily `str::cmp`.

### 6.2 `compareOrientationObservations` (`intrinsicShortSideObserver.ts:619-668`)

Two-stage: first an "exact dimension" block, short-circuited if non-zero:

```
Number(!first.exactLegal) - Number(!second.exactLegal)          // illegal loses
  || compareOptionalGrid(shortfallGrid_first, shortfallGrid_second)   // smaller shortfall wins
  || compareOptionalGrid(longAxisUsedSpanGrid_first, longAxisUsedSpanGrid_second) // smaller depth wins
```

then, only if that block is `0`:

```
cavityCount_first - cavityCount_second                                    // fewer cavities wins
  || compareOptionalExactRatio(hullGapGrid2, occupiedHullGrid2, ...)       // smaller hull-gap ratio wins (exact cross-mult.)
  || Number(!cohesionPasses_first) - Number(!cohesionPasses_second)        // certificate pass wins
  || compareOptionalExactRatio(deficitNumerator, deficitDenominator, ...)  // smaller deficit ratio wins
  || compareOptionalBigIntStrings(envelopeAreaGrid2_first, ...)            // smaller envelope area wins
  || compareOptionalGrid(maxSideGrid_first, ...)                           // smaller max side wins
  || compareOptionalGrid(spanGrid_first, ...)                              // smaller span wins
  || (second.dominantStructuralContacts - first.dominantStructuralContacts)  // more contacts wins (note operand order)
  || (second.totalStructuralContacts - first.totalStructuralContacts)        // more contacts wins
  || (hash ?? '￿').localeCompare(hash ?? '￿')                              // hash order; missing hash sorts last
  || (first.rotationDeg - second.rotationDeg)                                // q0 before q90
```

`compareOptionalGrid`/`compareOptionalExactRatio`/`compareOptionalBigIntStrings`
(`:670-709`) share the convention "`undefined` sorts after any defined value,
`undefined === undefined` is a tie" — but note `compareOptionalExactRatio`
implements this with `firstDefined === secondDefined ? 0 : firstDefined ? -1
: 1` (`:680-682`, i.e. **defined-before-undefined**, consistent), while
`compareOptionalBigIntStrings` and `compareOptionalGrid` implement it directly
as `first === undefined ? (second === undefined ? 0 : 1) : (second ===
undefined ? -1 : ...)` (`:697-698`, `:706-707`) — same net effect, different
code shape; a Rust port should use one shared helper rather than
re-deriving three near-identical but textually different implementations.

The `'￿'` sentinel (`U+FFFF`, `:478`, `:663-665`) is used as an
always-sorts-last placeholder for a missing hash inside a *string* compare
context (it's a legal but non-canonical Unicode code point, guaranteed larger
than any lowercase hex digit under UTF-16 code-unit order).

### 6.3 `comparisonTuple` (`intrinsicShortSideObserver.ts:446-480`)

Diagnostic-only display tuple (not itself a sort key elsewhere) attached to
each `IntrinsicShortSideOrientationObservation.comparisonTuple` for trace
readability; mirrors most of §6.2's ordering intent but is **not** identical
in field composition (e.g. it lacks the exact-ratio hull-gap/deficit terms
and instead reports `hullGapRatio`/`cohesionDeficit` as plain floats) — do
not port this as if it were authoritative; it is telemetry.

### 6.4 `directionalFillTier` (`intrinsicShortSidePairFoldObserver.ts:813-827`)

```
tier 2 iff 100n * shortAxisSpanGrid >= 99n * requestedShortAxisGrid   (>= 99% fill)
tier 1 iff (not tier 2) and 5n * shortAxisSpanGrid >= 4n * requestedShortAxisGrid  (>= 80% fill)
tier 0 otherwise
```
Both bounds are exact BigInt cross-multiplications, no floats.

### 6.5 `selectDirectionalIncumbent` (`intrinsicShortSidePairFoldObserver.ts:765-801`)

This is the **actual, sole, final selection function** choosing between the
pair-fold/shelf incumbent, the depth-first strip, the contact-first strip,
and (when reached) the reverse/piece-id-ascending continuations, and it is
called pairwise, threading the running best through each comparison (`:514`,
`:632`, `:710`, `:723`). Rules, applied in order, short-circuiting:

1. Only `'accepted'`-status outcomes are eligible; a non-accepted `first`
   loses outright unless `second` is also non-accepted, in which case the
   result is `undefined` (`:769-770`).
2. If either `exactPromotionMetrics` extraction fails (missing grid fields —
   should not happen for `'accepted'` outcomes but is defensively handled),
   prefer whichever side has the metrics (`:773-774`).
3. `directionalFillTier` — higher tier wins outright (`:775-779`).
4. If **both** are tier `< 2` and their `shortAxisSpanGrid` differ, the
   larger short-axis span wins outright (`:780-785`) — note this rule is
   **skipped entirely** once either side reaches tier 2 (≥99% fill); at tier
   2 the comparison falls through to envelope area even if short-axis spans
   differ.
5. Smaller `envelopeAreaGrid2` (BigInt) wins (`:786-788`).
6. Smaller `longAxisDepthGrid` wins (`:789-791`).
7. `compareDirectionalTopology` (§6.6) decides (`:792-795`).
8. Final tie-break: `(first.canonicalGeometryHash ?? '').localeCompare(second...) <= 0`
   picks `first` (`:796-800`) — note the `<= 0` here (unlike the strict `<`
   used for candidate ties in §5), so a genuine hash tie or a missing-hash
   tie (`'' vs ''`) deterministically prefers whichever outcome was passed as
   `first` in that call.

**This function does not read `collisionEnvelopeDensity`, `admission.*`
fields, or the promotion no-regression terms at all.** See §15 finding 2 for
why this contradicts the module's own doc comment and the historical
research/history docs.

### 6.6 `compareDirectionalTopology` (`intrinsicShortSidePairFoldObserver.ts:829-867`)

```
enclosedCavityCount: fewer wins; missing (undefined) loses to any defined value; both missing ties
  || hullGap ratio via cross-multiplication (firstGap*secondHull vs secondGap*firstHull), smaller wins;
     either interlocking record missing: defined side wins, both missing ties
  || isolatedPieceCount: fewer wins
  || positiveContactComponentCount: fewer wins
  || (second.largestPositiveContactComponentSize - first.largestPositiveContactComponentSize)  // larger wins
```

### 6.7 `evaluateIntrinsicShortSideContactStripPromotion` (`:878-1014`)

Computes eight `*NotRegressed` booleans plus `strictlyImproved` and
`promoted = contactStripAdmitted && all eight NotRegressed && strictlyImproved`
(`:1002-1013`). **This result is stored only in the trace field
`contactStripPromotion` (`:745`) and is not read anywhere else in the file**
(confirmed by grep — the only two occurrences of the identifier `promotion`
in the file are its definition at `:717` and its use as a trace field at
`:745`). It does not gate `selected` (§6.5, §15 finding 2).

### 6.8 `compareSelectedTransforms` / `compareShelfTransforms` (`:1050-1068`)

Per-piece single-transform selection for the pair-fold and shelf families
respectively:

```
pair-fold:  widthGrid asc || heightGrid asc || transform.index asc || rotationDeg asc || mirrored(false<true) asc
shelf:      heightGrid asc || widthGrid desc || transform.index asc || rotationDeg asc || mirrored(false<true) asc
```

`Number(boolean)` coerces `false→0, true→1`, so "mirrored asc" means
unmirrored wins ties.

### 6.9 `compareSelectedPairs` (`:1070-1087`)

```
envelopeAreaGrid2 (BigInt) asc || depthGrid asc
  || bottomPieceId.localeCompare(...) || upperPieceId.localeCompare(...)
```

### 6.10 `compareAnchoredCandidates` (`intrinsicShortSideContactStrip.ts:518-530`)

The directional bottom-left contract for contact-strip candidate selection:

```
maxLongAxisGrid asc || anchorLongAxisGrid asc || anchorShortAxisGrid asc
  || maxShortAxisGrid asc || translationShortAxisGrid asc || translationLongAxisGrid asc
  || transformIndex asc || rotationDeg asc || mirrored(false<true) asc
```

### 6.11 `compareContactScores` (`intrinsicShortSideContactStrip.ts:708-717`)

```
positiveContactCount asc  (more contact wins, since caller wants scoreOrder > 0 to win, see below)
  || axisUnits (BigInt) asc
```

Used at `:633-637`: a challenger replaces the winner iff
`compareContactScores(challenger, winner) > 0`, or equal score **and**
`compareAnchoredCandidates(challenger, winner) < 0` (i.e. shallower/more
bottom-left wins pure geometric ties after an equal contact score) — this is
the exact contact tuple (§6.12 below expands the tuple's field semantics).

### 6.12 The exact Short Side contact tuple (special focus)

Per candidate, per already-placed piece, `candidateContactAxisUnits`
(`intrinsicShortSideContactStrip.ts:657-706`) computes two **independently
sourced** numbers that are then combined into one `ContactScore {
positiveContactCount: number; axisUnits: bigint }`:

- `positiveContactCount` increments once per placed piece for which
  `hasPositiveCanonicalGridBoundaryContact(worldPath, placedWorldPath)` is
  `true` (`:680-687`). That function (`canonicalGridContact.ts:37-52`) returns
  `true` if **any** pair of collinear, overlapping edges exists between the
  two paths — collinearity is tested via `canonicalGridCrossSign` (exact,
  BigInt-backed for large coordinates), and "overlap" only requires positive
  axis-projected length along whichever of that edge's own dx/dy is larger
  (`canonicalGridContact.ts:236-265`). Crucially this test is **orientation-
  agnostic** — a diagonal (non-axis-aligned) collinear-overlapping edge pair
  counts exactly the same as an axis-aligned one for this boolean. This is the
  "diagonal and axis-aligned contacts both contribute to positive-contact
  count" rule.
- `axisUnits` is the running BigInt sum, across all placed pieces, of
  `measureCanonicalGridBoundaryOverlapAxisUnits(worldPath, placedWorldPath,
  checkpoint)` (`:689-700`). This function (`canonicalGridContact.ts:302-337`)
  sums exact axis-projected overlap **only for edge pairs whose overlapping
  edge is axis-aligned** (`dx !== 0n && dy !== 0n` for a positive-overlap edge
  ⇒ the whole call for that (first,second) path pair returns `{kind:
  'undecidable'}`, `canonicalGridContact.ts:328-332`); the contact-strip loop
  treats `'undecidable'` as "contribute 0 axis units for this placed-piece
  pair, keep scanning the rest" (`continue`, `intrinsicShortSideContactStrip.ts:697-699`) —
  it does **not** abort the whole candidate's score. So: a diagonal contact
  against one particular placed piece silently zeroes only that one placed
  piece's contribution to `axisUnits`, while still incrementing
  `positiveContactCount` by 1 for that same placed piece (from the independent
  `hasPositiveCanonicalGridBoundaryContact` call). This is the exact
  mechanism behind "only axis-aligned overlap contributes to projected-length
  tie-breaking" — and it is a *per placed-piece-pair* decision, not a
  per-candidate all-or-nothing decision.
- `serializeContactScore` renders this as the string `"${positiveContactCount}:${axisUnits}"`
  (`:719-723`) purely for trace/tie-evidence display (`:765-766`,`:776-778`);
  it is never used for comparison, only display — comparison always uses
  `compareContactScores` on the structured `ContactScore`.
- Aborting (deadline/memory-cap) during this scan is distinguished from
  "undecidable" (`overlap.kind === 'aborted'` returns `{score: undefined,
  bounded: boundedDuringScan}`, `:694-696`, vs `'undecidable'` which
  `continue`s the scan, `:697-699`) — a Rust port must keep these as two
  different control-flow outcomes (one is a hard stop with a bounded status,
  the other silently skips one term of the sum).

## 7. Numeric semantics

### 7.1 Float→grid conversion (`clipper2OffsetPolicy.ts:44-53`)

`toGridMm(valueMm)`: scale by `1000` (grid unit = 0.001 mm = 1 canonical
"micron" unit), then `Math.floor(scaledAbsoluteValue + 0.5)` (round
half-up on the absolute value), then re-apply `Math.sign(valueMm)` — this is
"round to nearest, ties away from zero" on the *signed* value. Returns
`undefined` if the input isn't finite or the result isn't a JS safe integer
(`Number.isSafeInteger`). **Signed-zero hazard:** for `valueMm === -0` (or any
input tiny enough that `scaledAbsoluteValue < 0.5`), `Math.sign(valueMm)` is
`-0` (`Math.sign(-0) === -0`), and `-0 * 0 === -0` in IEEE754, so `toGridMm`
can return `-0` (a JS "negative zero" `number`). Downstream, `x === 0`
comparisons treat `-0` and `0` as equal, and `BigInt(-0) === 0n`, so this is
mostly benign — but any code path relying on `Object.is` or that serializes
the raw number (rather than going through `x === 0 ? 0 : x` normalization, as
`placedCollisionWorldGridPath` explicitly does at `canonicalLayoutGeometry.ts:100-101`)
could observe `-0`. `fromGrid` (`clipper2OffsetPolicy.ts:56-58`) is a plain
division by `1000`, no rounding.

### 7.2 Signed-zero normalization for rotated coordinates (`irregularBeamState.ts:475-498`)

`rotateQuarterTurnPoint` explicitly normalizes `-0 → 0` via
`normalizeNegativeZero` (`Object.is(value, -0) ? 0 : value`, `:496-498`) on
every rotated x/y coordinate, for **all four** quarter turns including the
0°/180° cases where the coordinate is unchanged in magnitude but a `-x`/`-y`
negation on an already-zero coordinate can produce `-0`. A Rust `f64` port
must reproduce this: Rust's unary negation of `0.0_f64` produces `-0.0`, so an
un-normalized Rust port would silently diverge in sign bit (though not in
numeric value) from this TS behavior at every rotation touching a
zero-valued coordinate.

### 7.3 BigInt exact-arithmetic surfaces used throughout this cluster

- Envelope area: `BigInt(widthGrid) * BigInt(depthGrid)` (multiple sites,
  e.g. `intrinsicShortSidePairFoldObserver.ts:461,1312,1349`).
- Doubled polygon area (shoelace, exact): `collisionMaterialArea`
  (`intrinsicShortSidePairFoldObserver.ts:1513-1530`) accumulates
  `BigInt(point.x)*BigInt(next.y) - BigInt(next.x)*BigInt(point.y)` per edge,
  takes `signed < 0n ? -signed : signed` per polygon, and sums doubled areas
  across pieces — never converts to `Number` until final display
  (`Number(envelopeAreaGrid2) / 1_000_000` for `envelopeAreaMm2`, `:1313`).
- Area-cost bound: exact `3n * candidate <= 4n * production` cross-multiplication
  (`intrinsicShortSideObserver.ts:44-52`).
- Fill/shortfall/depth admission bounds: `100n`/`99n`, `5n`/`4n`, `2n` factor
  cross-multiplications throughout (`intrinsicShortSideObserver.ts:594-604`,
  `intrinsicShortSidePairFoldObserver.ts:371-372,818-824`).
- Hull-gap ratio comparisons: cross-multiplied BigInt products, never a float
  division comparison (`intrinsicShortSidePairFoldObserver.ts:851-859,961-965,980-983`).
- `canonicalGridCrossSign` (`canonicalGridMath.ts:82-109`) uses a proven exact
  `Number`-domain fast path when every coordinate's absolute value is `<=
  2**25 - 1` (documented bound proof in the source comment, `:50-62`), falling
  back to full BigInt cross-product otherwise. A Rust port must reproduce
  both the fast-path bound and the fallback threshold exactly, not just "use
  i128 always" (which would be safe but is not what this file's proof claims
  and not what downstream code paths that check `Number.isSafeInteger` on the
  *result* assume elsewhere).

### 7.4 Plain `Number` arithmetic / `Math.*` used only for display or budget checks

- `Math.max`/`Math.min` for bounds, budgets, and non-authoritative display
  ratios throughout (e.g. `intrinsicShortSidePairFoldObserver.ts:430,435,438`
  width/depth accumulation for pair layout — **these are exact integer
  `number` operations on already-`toGridMm`-quantized safe integers**, so
  `Math.max` of two safe integers is itself exact; no float rounding risk
  here even though the type is `number`).
- `Math.hypot` for Euclidean edge lengths in `canonicalGridContact.ts:352,365`
  — genuinely floating-point, used only for telemetry (`sharedBoundaryLengthMm`,
  structural-contact signatures used for a *different* metric family, not the
  Short Side contact tuple of §6.12) and for the near-complete structural
  signature scale used in `measureCanonicalLayoutContacts` — not part of the
  exact contact tuple.
- `performance.now()` (default clock, injectable via `runtimeControl.now`) and
  `process.memoryUsage.rss()` (default RSS sampler, injectable via
  `runtimeControl.currentRssBytes`) are the only wall-clock/measurement
  sources; both are non-deterministic by nature and explicitly excluded from
  parity by the migration prompt's timing-field rules (§18.3 of the prompt).
- `Number.isSafeInteger` / `Number.isFinite` guards appear pervasively as
  validity gates that turn "unrepresentable" into `undefined` rather than
  silently truncating (e.g. `canonicalDimensions`,
  `intrinsicShortSideObserver.ts:729-735`; `physicalDimensions`,
  `intrinsicShortSidePairFoldObserver.ts:1495-1497`) — a Rust port must
  reproduce "reject and propagate `None`/error" rather than saturate or wrap.

### 7.5 No NaN/Infinity production paths found

`Number.POSITIVE_INFINITY` is used only as an explicit *sentinel* for "missing
value sorts last" in `comparisonTuple` (`intrinsicShortSideObserver.ts:465-466`,
display-only) and as the default `maximumCandidateEvaluations`/
`maximumBacktracks` (`intrinsicShortSideContactStrip.ts:200-204`, meaning "no
cap"); a Rust port should model these as `Option<u64>`/`u64::MAX`, not `f64::INFINITY`,
to avoid float-comparison semantics for what is really an unbounded counter.

## 8. Serialization and hashing

### 8.1 Trace byte-size self-measurement (double-`JSON.stringify` fixpoint)

Both `intrinsicShortSideObserver.ts` and `intrinsicShortSidePairFoldObserver.ts`
implement the same two-pass pattern to make a trace self-report its own
serialized size:

```ts
// intrinsicShortSideObserver.ts:747-754
const firstMeasurement = Buffer.byteLength(JSON.stringify(trace), 'utf8')
const measured = { ...trace, serializedTraceBytes: firstMeasurement }
const finalMeasurement = Buffer.byteLength(JSON.stringify(measured), 'utf8')
return { ...measured, serializedTraceBytes: finalMeasurement }
```
(identically shaped at `intrinsicShortSidePairFoldObserver.ts:1654-1665`).
This is **not** a true fixpoint — it stringifies twice and trusts that adding
the `serializedTraceBytes` field itself (an integer, at most a handful of
extra ASCII digits) doesn't change the byte length enough to require a third
pass. A Rust port that reproduces `serializedTraceBytes` byte-for-byte must
replicate this exact two-pass (not fixpoint-iterate-to-convergence) algorithm,
including the fact that a JSON encoding whose byte length crosses a
digit-count boundary between passes (e.g. `99999999` → `100000000` bytes,
9 vs 10 digits) would under- or over-report by one byte in this
implementation, and the Rust port must reproduce that exact (mild) inaccuracy
rather than "fixing" it, per the semantics-preservation rule.

`selectedOutputTraceSize` (`intrinsicShortSideObserver.ts:271-274` inline,
and `intrinsicShortSidePairFoldObserver.ts:1671-1676` as a named helper) reruns
this whole two-pass measurement with `outputInfluence` forced to `'selected'`
purely to check whether the trace *would* fit the byte cap if it were the
chosen output — this measured value is discarded and only the size is used
for the cap comparison (`intrinsicShortSideObserver.ts:271-278`,
`intrinsicShortSidePairFoldObserver.ts:750-757`, `:1254-1267`).

### 8.2 Canonical geometry hashing

Both `intrinsicShortSideObserver.ts:743-745` (`hashCanonicalIdentity`) and
`intrinsicShortSidePairFoldObserver.ts:1448` (inline) compute
`createHash('sha256').update(identity).digest('hex')` where `identity` is the
string returned by `canonicalCollisionLayoutIdentity` (owned by
`canonicalLayoutGeometry.ts`, out of this cluster's scope, but the input
contract is: a string built by picking the lexicographically-smallest of the
four quarter-turn canonical ring encodings, `canonicalLayoutGeometry.ts:139-150`).
This is plain Node `crypto.createHash`, UTF-8 input (implicit default
encoding of `.update(string)`), hex digest output — no custom canonical byte
encoder in *this* cluster; the canonical string itself is built upstream.

### 8.3 `JSON.stringify` field-omission semantics

Every trace interface in this cluster (`IntrinsicShortSideObserverTrace`,
`IntrinsicShortSideOrientationObservation`, `IntrinsicShortSideEndpointObservation`,
`IntrinsicShortSidePairFoldTrace`, `IntrinsicShortSideContactStripTrace`,
`IntrinsicShortSideContactStripTieEvidence`) is a plain TS object-literal type
(`readonly` fields, `| undefined` unions), not an `Effect.Schema`-branded
class with `declare`/`hasOwnProperty` field presence tracking (contrast
`IrregularPlacement`/`IrregularPreparedPiece` in §3.4-adjacent domain types,
which *do* use that pattern, `src/shared/irregular/domain.ts:662-674,700-713`).
Concretely: every one of these trace objects sets `field: undefined`
explicitly when a value is absent (rather than omitting the key), and
`JSON.stringify` drops keys whose value is `undefined` — so the two are
observationally identical in the emitted JSON bytes, but a Rust
`serde`-derived struct must use `Option<T>` with `skip_serializing_if =
"Option::is_none"` (or equivalent) to match, and must **not** attempt to
distinguish "key present with `null`" from "key absent" for these fields,
because the TS source never does either (it always uses `undefined`, never
`null`, in this cluster).

### 8.4 No BigInt values are serialized as BigInt anywhere in this cluster's JSON traces

Every BigInt value that ends up in a trace field is first converted with
`.toString()` (base-10, e.g. `envelopeAreaGrid2.toString()`,
`intrinsicShortSidePairFoldObserver.ts:1446`; `productionEnvelopeAreaGrid2.toString()`,
`intrinsicShortSideObserver.ts:246`) — these trace types declare the field as
`string`, not `bigint`, so `JSON.stringify` never encounters a raw `bigint`
(which would throw `TypeError` in native `JSON.stringify`) in this cluster.
Comparators that need the numeric value back parse with `BigInt(stringValue)`
(e.g. `compareOptionalBigIntStrings`, `intrinsicShortSideObserver.ts:693-699`).

## 9. Caches touched and access sequence

This cluster **does not implement or touch any cache itself.** It calls
`geometryKernel.transformCollisionGeometry` and
`nfpIfpService.generatePlacementCandidates`, both of which may consult
caches internally (owned by `../../irregular/geometryKernel.ts`,
`../../irregular/nfpIfpService.ts` and friends — a different characterization
cluster). From this cluster's point of view those are opaque, side-effect-free
(besides internal caching) calls: same logical input ⇒ same logical output,
with the caching layer's job to make repeated calls with structurally
equivalent inputs fast. There is no cache invalidation, staleness check, or
publish/evict logic inside any of the four files in this cluster. The
"historical access sequence" requirement from the migration prompt (§9) is
therefore **not applicable to this cluster directly**; it applies to the
callee services, and the Rust port only needs to preserve *call order and
call count* into those services from this cluster (§4, §10), not any caching
mechanics.

One cluster-local memoization-adjacent behavior worth flagging: the
contact-strip's checkpoint/backtrack mechanism (`intrinsicShortSideContactStrip.ts:248-413`)
**recomputes** candidate generation for the resumed prefix's next piece from
scratch after a backtrack (the `while (pieceIndex < ...)` loop re-enters
`nfpIfpService.generatePlacementCandidates` normally at the new `pieceIndex`,
`:250-337`) — it does not cache or replay previously computed candidates for
pieces before the checkpoint; only the **placement decisions** for the prefix
(`checkpoint.placedBefore` + `checkpoint.baselinePiece`) are reused, not their
candidate sets. This is a deliberate, source-verified behavior (matches the
"resumable" framing in the code comment at `:156-169`) and must not be
"optimized" into a candidate cache during the Rust port without proving the
resulting selection is identical.

## 10. Cancellation / deadline / budget / evaluation-cap observation points

**No file in this cluster reads `ComputeIrregularNestingOptions.isCancelled`
or any external cancellation token.** All bounding is self-contained,
wall-clock- and RSS-budget-based, using the runtime records described in §4.

### 10.1 `intrinsicShortSideObserver.ts` — two budgets, both checked only *after* full computation

- `INTRINSIC_SHORT_SIDE_OBSERVER_MAX_RUNTIME_MS = 250` (`:31`) — checked once,
  after the entire endpoint/orientation evaluation and ranking has already run
  to completion (`measured.runtimeMs > ...`, `:268-270`). There is **no**
  per-endpoint or per-orientation cooperative check inside the loops
  (`:161-217`) — this is a post-hoc budget, not a loop-interruptible one.
- `INTRINSIC_SHORT_SIDE_OBSERVER_MAX_TRACE_BYTES = 1_048_576` (`:32`) —
  checked once after the runtime check passes, by re-measuring the trace with
  `outputInfluence: 'selected'` (`:271-278`).
- On either breach, `censoredTrace` (`:756-771`) replaces `endpoints`,
  `rankedCanonicalGeometryHashes`, and the winner fields with empty/`undefined`
  values but **keeps** the already-computed summary counters
  (`settledEndpointCount`, `evaluatedOrientationCount`, etc.) — i.e. the trace
  reports what *would have been* evaluated, not that evaluation was skipped.

### 10.2 `intrinsicShortSidePairFoldObserver.ts` — three budgets, cooperative

- `INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RUNTIME_MS = 30_000` (`:37`).
- `INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RSS_DELTA_BYTES = 512 * 1_048_576` (`:38`).
- `INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_TRACE_BYTES = 1_048_576` (`:39`).
- `boundedStatus(runtime)` (`:1574-1579`) is checked at these exact positions
  inside `constructPairFold`: before each `(piece, transform)` evaluation
  (`:346`), before each unordered pair evaluation twice — once before
  incrementing `evaluatedPairCount` and once immediately after (`:413,440`),
  before/after the depth-first contact-strip sub-call
  (`:551`, budget computed for the sub-call at `:516-523`), before/after the
  contact-first sub-call (`:611`, budget at `:572-579`), before/after each
  order-continuation sub-call (`:691`, budget at `:654-662`), and inside
  `finalizePlacedLayout` both before (`:1186`) and after (`:1239`) exact
  finalization. **Sub-call budgets are the minimum of the sub-module's own
  fixed constant and the outer observer's remaining allowance**
  (`Math.min(INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RUNTIME_MS,
  outerRuntimeRemainingMs)`, `:535-538` and analogous RSS line `:539-542`) —
  budgets compose downward, never upward.
- Trace-byte cap is checked twice: once on the composite trace after strip
  selection (`:750-757`) and once inside `finalizePlacedLayout`/`finalizeOutcome`
  for each individual construction's own trace before it's returned as a
  candidate incumbent (`:1254-1267`).

### 10.3 `intrinsicShortSideContactStrip.ts` — four budgets, cooperative, plus an NFP-service checkpoint bridge

- `INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RUNTIME_MS = 20_000` (`:31`).
- `INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RSS_DELTA_BYTES = 256 * 1_048_576` (`:32`).
- `INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_CANDIDATE_EVALUATIONS = 2_000` (`:33`,
  only applied when the caller passes it explicitly — the pair-fold observer
  passes it only for the `'contact-first'` lane, `intrinsicShortSidePairFoldObserver.ts:591-592`;
  the depth-first and continuation lanes get the default `Number.POSITIVE_INFINITY`).
- `INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_BACKTRACKS = 4` (`:35`, same
  caller-gating: only the `'contact-first'` lane passes it,
  `intrinsicShortSidePairFoldObserver.ts:593-594`).
- `boundedStatus` checks appear: once per piece before generating any
  candidates for it (`:262`), inside the NFP/IFP service's own `checkpoint`
  callback (`:286-296` — this is the bridge into the callee's cooperative
  checkpoint mechanism, `IrregularNfpIfpCheckpointPhase` phases `'ifp' |
  'placed-nfp' | 'ifp-boundary-intersection' |
  'pairwise-nfp-boundary-intersection' | 'candidate-points'`, defined in
  `../../irregular/services.ts:78-83`, out of cluster scope but the bridging
  contract is in-scope), once immediately after candidate generation returns
  (`:299-308`), once per raw candidate **after** incrementing
  `candidateEvaluations` but **before** incrementing further (evaluation-cap
  check first, `:310-322`, wall-clock/RSS check second, `:323-332`), and
  inside `selectContactAwareWinner`'s three internal loops (baseline scan
  `:551-552`, tie collection `:560-561`, challenger scan `:605-606`) — i.e.
  even the O(n²) contact-score comparison loop is checkpointed per candidate,
  not just per piece.
- `IrregularNfpIfpControlAbortError` from the NFP service is caught at the
  outermost `constructIntrinsicShortSideContactStrip` boundary
  (`:208-229`) and remapped to `boundedStatus(runtime) ?? 'deadline'`
  (`:214-219`) — **the abort error's own `reason` field ('deadline' |
  'cancelled') is discarded and re-derived from local runtime state**; note
  the checkpoint callback itself reports `reason: bounded === 'deadline' ?
  'deadline' : 'cancelled'` (`:291-292`) — so a local `'memory-cap'` condition
  is reported to the NFP service using the **wrong** literal reason
  (`'cancelled'`, since the abort error type has no `'memory-cap'` reason at
  all) and then correctly re-derived as `'memory-cap'` on the way back out.
  This double round-trip through a mislabeled intermediate reason string is a
  genuine, source-verified quirk (not a bug I'm asked to fix) that a Rust
  port must reproduce in effect (final trace status is correct) without
  necessarily reproducing the intermediate mislabeling if it never crosses
  an observable boundary — but note it **does** cross into the message string
  interpolated at `intrinsicShortSideContactStrip.ts:294` ("`${bounded}
  reached during contact-strip ${phase}.`" — wait, that interpolates the
  *locally recomputed* `bounded`, not the mislabeled `reason`, so the message
  is accurate; only the discarded `IrregularNfpIfpControlAbortError.reason`
  field itself is mislabeled and it is never read after being thrown/caught
  here).

### 10.4 No cancellation returns partial geometry

Every bounded exit in all three files returns `placedCollisionGeometries:
undefined` (verified: `failedOutcome` in both `intrinsicShortSidePairFoldObserver.ts:1586-1652`
and `intrinsicShortSideContactStrip.ts:811-844` always sets
`placedCollisionGeometries: undefined`), consistent with the migration
prompt's "no partial-result rule" (§15 of the prompt).

## 11. Error paths

### 11.1 Tagged errors that can reach this cluster from callees

- `IrregularGeometryInputError`, `IrregularNestingNotImplementedError` (from
  `geometryKernel.transformCollisionGeometry` / `nfpIfpService.*`) — caught at
  the outer boundary of `observeIntrinsicShortSidePairFold`
  (`intrinsicShortSidePairFoldObserver.ts:275-303`) and of
  `constructIntrinsicShortSideContactStrip`
  (`intrinsicShortSideContactStrip.ts:220-227`), both times converted into a
  normal `status: 'failed-protected-fallback'` outcome, **not** re-thrown.
  **This means these two error tags never reach `computeIrregularNesting.ts`'s
  error channel through this cluster** — they are absorbed and turned into a
  Short Side trace status. The only externally observable effect, if this
  absorption causes every portfolio branch to fail, is the generic
  `IrregularNoValidResultError` → `irregular_no_valid_result` raised by
  `computeIrregularNesting.ts:1194-1200` when `shortSideProfileRequested &&
  !shortSideSelected`. **This is a real divergence from the module-agnostic
  error-mapping table in the migration prompt's §16**, which lists
  `IrregularGeometryInputError → irregular_geometry_invalid` as if that
  mapping always applies — inside the Short Side cluster specifically, a
  geometry-input error during directional construction is silently
  downgraded to `irregular_no_valid_result` instead. Flagged prominently in
  §15 as something the Rust port must decide how to reproduce.
- `IrregularNfpIfpControlAbortError` (`reason: 'deadline' | 'cancelled'`) —
  caught only inside `constructIntrinsicShortSideContactStrip`
  (`:210-219`), converted to a bounded trace status (§10.3); never leaks as
  an Effect failure out of this cluster.

### 11.2 Errors this cluster can itself raise (undischarged, propagate to the caller)

None of the four files defines its own tagged error class. The Effect type
signatures of `observeIntrinsicShortSidePairFold` and
`constructIntrinsicShortSideContactStrip` are explicitly `Effect<..., never,
...>` (§3.3, §3.4) — by construction, no error can escape either function.
`observeIntrinsicShortSideOrientations` is fully synchronous (not an
`Effect`) and cannot throw under normal conditions (every internal helper
returns `undefined` rather than throwing on invalid geometry).

### 11.3 `IrregularNoValidResultError` (from the caller, not this cluster)

Raised only in `computeIrregularNesting.ts:1194-1200`, with `operation:
'intrinsicShortSide'` and a message embedding `archive=<observer trace
status>` and `terminal=<pair-fold trace status ?? 'not-run'>`. Mapped to
`irregular_no_valid_result` at `src/workers/nesting.worker.ts:440-443`
with no additional context fields beyond what the base error class carries
(`operation`, `message`) — consistent with the migration prompt's error table
(`IrregularNoValidResultError → irregular_no_valid_result`, context
`operation`).

## 12. JS-specific semantics hazards for a Rust port

- **Stable sort reliance** — every `.toSorted`/`.sort` call in this cluster
  (§5) can, in principle, hit exact ties on its full comparator chain;
  reproduce with an explicit stable sort or an appended original-index
  tie-break, never `sort_unstable`.
- **String comparison mix** — this cluster uses **both** `.localeCompare`
  (hash/piece-ID comparisons in §6.1, §6.5, §6.9) **and** plain `<`/`>`
  operators on strings (`sortByPieceId`, §5 item 3; note this is a *different*
  function from the piece-ID `.localeCompare` calls elsewhere — the two
  orderings are not guaranteed to coincide for non-ASCII piece IDs). A Rust
  port must not assume `str::cmp` is a drop-in replacement for either; verify
  against V8's default-locale `localeCompare` behavior (effectively code-point
  order for the hex-hash and typical-ASCII-piece-ID cases exercised in
  practice, but not guaranteed in general) versus plain UTF-16 code-unit `<`.
- **UTF-16 vs UTF-8** — all strings compared here (hex hashes, piece IDs) are
  expected to be ASCII in practice, so UTF-16/UTF-8 divergence is unlikely to
  bite, but is not proven absent by this cluster alone (piece IDs originate
  from user-imported DXF/CSV data, out of scope here).
- **Signed zero** — §7.1, §7.2. Two independent signed-zero-producing code
  paths (`toGridMm`'s `Math.sign`, and rotation negation) exist in this
  cluster's dependency chain; only the rotation path is explicitly
  normalized in-cluster (`irregularBeamState.ts:496-498`); `toGridMm`'s
  output is normalized only at its own call sites that care
  (`canonicalLayoutGeometry.ts:100-101`), not universally.
- **`Object.is` semantics** — `normalizeNegativeZero` uses `Object.is(value,
  -0)` specifically because `value === -0` is `true` for both `+0` and `-0`
  in JS; Rust's `f64` has no such ambiguity issue in equality but does
  distinguish `0.0.to_bits() != (-0.0f64).to_bits()`, so the Rust
  reproduction should use a bit-pattern or `x == 0.0 && x.is_sign_negative()`
  check, not `x == -0.0` (which is always `true` for `+0.0` too, same trap in
  reverse).
- **`Map`/`Set` insertion order** — not load-bearing in this cluster (§5);
  every `Map`/`Set` here is used strictly for `.has`/`.get`/`.size`, never
  iterated for output order. Confirmed by inspection of every `new Map(`/`new
  Set(` occurrence in all four files.
- **Closure-captured mutable state** — the `ObserverRuntime`/`StripRuntime`
  mutable records (§4) are captured by reference in nested closures (e.g. the
  `checkpoint` callback passed into `generatePlacementCandidates`,
  `intrinsicShortSideContactStrip.ts:286-296`, and the `currentRssBytes`
  wrapper closures created fresh per sub-call in
  `intrinsicShortSidePairFoldObserver.ts:544-548,603-607,682-687`, each of
  which mutates the **outer** `runtime.peakRssBytes` as a side effect of
  being called). A Rust port must model this as `&mut` state threaded
  explicitly (or an `Rc<RefCell<..>>`/interior-mutability equivalent scoped
  to one job), not as independent per-call state — the side effect of
  updating `peakRssBytes` from a nested sub-call's RSS sampler is
  load-bearing for the outer observer's own final `peakRssDeltaBytes` report.
- **ES2023 array methods** (`toSorted`, `toReversed`, `.at(-1)`) — purely
  syntactic; semantics are unambiguous copying/reversal, no hazard beyond
  "don't accidentally mutate the source array in the Rust port when the TS
  used the non-mutating variant, or vice versa."
- **`%`-based rotation-degree normalization** (`irregularBeamState.ts:491-494`)
  — JS `%` can return a negative remainder for negative operands;
  `normalizeRotationDegrees` explicitly corrects this
  (`remainder < 0 ? remainder + 360 : remainder`); Rust's `%` has the same
  sign behavior as JS for this domain (both truncate toward zero), so the
  same explicit correction is needed, not `rem_euclid` substituted silently
  without verifying it produces bit-identical results for all inputs
  (it should, but state this as a target for a focused parity test rather
  than an assumption).

## 13. Parallelism assessment

### 13.1 Pure/independent, safe Rayon candidates (with the described caveats honored)

- **Per-endpoint q0/q90 observation** in `observeIntrinsicShortSideOrientations`
  (`intrinsicShortSideObserver.ts:161-169`): each `observeEndpoint` call is a
  pure function of `(sheet, endpoint, archiveIndex, requestedLongAxis,
  requestedShortAxisMm)` with no shared mutable state and no interaction with
  any other endpoint's evaluation. Independent, stable-indexed, and the
  result is consumed only after a serial re-sort — a strong Rayon candidate
  **provided** the eventual reduction re-sorts by `archiveIndex`-stamped
  results using the exact serial comparator (§6.1) rather than trusting
  parallel completion order. The runtime-budget check (§10.1) is currently a
  single post-hoc check on total elapsed wall time; parallelizing this loop
  changes the *wall-clock* elapsed time (likely making it shorter), which
  does not change the boolean 250 ms outcome in the vast majority of cases,
  but a Rust port must still measure the same wall-clock boundary
  (start-to-finish of this stage), not sum of per-task time, to stay
  semantically comparable to what the TS budget was actually protecting
  against.
- **Per-piece single-transform selection** in `constructPairFold`
  (`intrinsicShortSidePairFoldObserver.ts:337-398`): each piece's inner loop
  over `piece.transforms` to find the best pair-fold and shelf transform is
  independent across pieces (no shared state read besides the immutable
  `piece` itself) — but note the loop also increments the shared
  `runtime.transformEvaluations` counter and checks `boundedStatus` **inside**
  the per-transform loop (`:341-354`), so a naive parallelization would need
  to either (a) pre-compute the total transform count and stable-index every
  `(piece, transform)` pair before spawning work, evaluate purely, then
  serially fold the counter/budget accounting in original order, or (b) prove
  the specific budget check timing doesn't matter for this bounded, typically-
  small (≤ tens of transforms per piece) loop. Given the migration prompt's
  explicit instruction to preserve exact evaluation counts and the *position*
  of budget checks, treat this as parallelizable **only** for the pure
  geometry computation (`geometryKernel.transformCollisionGeometry` call),
  with counter increment and budget-check timing reconstructed serially by
  stable index afterward.
- **Contact-score computation across already-placed pieces** inside
  `candidateContactAxisUnits` (`intrinsicShortSideContactStrip.ts:657-706`):
  the loop over `placed` pieces for one candidate is a pure, read-only
  reduction (sum of `axisUnits`, boolean-or of `positiveContactCount`
  increments) with a cooperative checkpoint inside it (`:676-693`) — safe to
  parallelize the pure per-placed-piece contact test with a serial reduction
  **only if** the deadline/memory-cap checkpoint boundary is preserved at the
  same logical granularity (checked at least once per outer candidate
  evaluation, not silently removed by fusing the whole reduction into one
  uninterruptible parallel task). Given the checkpoint here exists
  specifically to bound worst-case O(n²) candidate-vs-placed scans on large
  inputs, removing its cooperative nature by parallelizing without an
  equivalent periodic check would violate §14.2 of the migration prompt
  ("mutable spatial-index updates" is not this, but "cancellation or deadline
  checks at new eager positions" and the general "preserve chronology" rule
  are directly relevant).

### 13.2 Chronology-bound, must stay logically serial

- **The entire piece-by-piece contact-strip construction loop**
  (`intrinsicShortSideContactStrip.ts:250-413`) is inherently sequential:
  each piece's candidate set depends on `placed`/`placedCollisionIndex`
  produced by all previously placed pieces (this is the core "each piece
  is placed once, in prepared order" design, `:156-169`), and the
  backtrack/checkpoint mechanism explicitly depends on prefix state.
  §14.2 of the migration prompt lists "Short Side portfolio branches where
  first success currently has defined authority" as high-risk — this loop
  is exactly that kind of sequential-decision process and must not be
  parallelized across pieces.
- **The four-lane terminal portfolio order** in `constructPairFold`
  (pair-fold/shelf → depth-first strip → contact-first strip → order
  continuations, `intrinsicShortSidePairFoldObserver.ts:319-762`) reads and
  writes a single shared `ObserverRuntime` (transform/pair evaluation
  counters, veto list, peak RSS) across all four lanes, and each later lane's
  runtime *budget* is explicitly computed as "outer budget minus already-
  consumed time/RSS" (`:516-523,572-579,654-662`) — i.e. lane N's available
  budget is a function of lanes `1..N-1`'s actual consumption. This is
  fundamentally chronology-bound and must remain serial across lanes, even
  though the *pure geometry work inside* one lane may itself contain safe
  Rayon opportunities (§13.1).
- **Checkpoint push/pop stack** (§5, §9) is an inherently serial LIFO
  structure tied to the sequential piece loop; not parallelizable.
- **`ObserverRuntime`/`StripRuntime` counters and RSS peak-tracking** are
  shared mutable accumulators read by budget checks that gate control flow
  (continue vs. abort) — any parallel access must be serialized before the
  next budget check, i.e. these are not safe to update concurrently without
  a full reduce-then-check barrier, which effectively serializes around
  every budget check anyway.
- **The final `selectDirectionalIncumbent` comparisons chaining incumbent →
  depth-strip → contact-strip → continuation-1 → continuation-2**
  (`intrinsicShortSidePairFoldObserver.ts:514,632,710,723`) are pairwise and
  order-dependent only in the sense that `selectDirectionalIncumbent` is
  commutative-looking but its final tie-break (`<= 0` picks `first`, §6.5
  item 8) makes the **argument order** (which side is `first`) semantically
  significant on exact ties — reordering these calls changes which
  construction wins a tie. Not a parallelism target; already O(1) serial
  work, called out here only because a well-meaning refactor (e.g. "reduce
  over an unordered list of the four candidates") would silently change tie
  outcomes and must not be done.

## 14. Tests and gates covering this cluster

Exact test files (found via `grep -rln` for the four module names and their
exported symbols over `tests/`):

- `tests/unit/intrinsicShortSideObserver.test.ts` (444 lines) — 10 cases:
  material short-axis fill ranking, Pareto-front tie-breaking, dominated-strip
  rejection, transpose/orientation-swap identity preservation, exact-integer
  admission boundary, area-cost-bound veto-at-one-grid-step-above (evidence,
  not gating — test name still says "vetoes a directional endpoint", worth
  re-reading closely during Rust unit-test design to confirm it asserts
  telemetry, not admission, given §15 finding 1), square-sheet physical-Y
  convention, no-legal-orientation handling, zero-work skip when no archive
  settled, runtime-budget censoring.
- `tests/unit/intrinsicShortSidePairFoldObserver.test.ts` (762 lines) — 14
  cases including: deterministic pair selection + transpose identity,
  "retains exact directional rows even below historical quality telemetry
  floors" (direct confirmation of §15 finding 2 — quality floors do not gate
  acceptance), shelf fallthrough, "records the historical area bound without
  vetoing exact directional output" and "records the exact four-thirds
  telemetry boundary without changing selection" (direct confirmations of
  §15 finding 3 — the area-cost bound is evidence-only), deadline/RSS budget
  sharing with the contact strip, trace-cap discard/enforcement (both before
  and after strip-comparison attachment), output-influence remeasurement,
  strip promotion at q0/q90, dual-lane recording without legacy-flag
  authority, and controlled promotion-boundary comparison (i.e. a test
  explicitly built to check the promotion *evidence* fields independent of
  whatever the emitted status flag says — consistent with §15 finding 2:
  the test suite itself treats `contactStripPromotion` as inspectable
  evidence, not as a control-flow driver, matching what the source does).
- `tests/unit/intrinsicShortSideContactStrip.test.ts` (348 lines) — 8 cases:
  interlocking-vs-bounding-box construction, canonical-identity
  reproducibility, floor-before-depth ordering, no-legal-placement reporting,
  deadline-without-partial-result, tied-anchor contacting-orientation
  preference, **"counts diagonal contact without projecting it into the
  axis-length suffix"** (direct unit coverage of §6.12's exact contact
  tuple), and depth-refusal for a deeper contacting alternative.
- `tests/unit/intrinsicCapacityIntegration.test.ts` — exercises the Short
  Side profile through the **full worker result and history path**
  (`describe('intrinsic capacity integration')`, case
  `'runs the Short Side profile through the existing worker result and
  history path'`, line 112), including asserting `computed.intrinsicShortSideObserverTrace`
  and `computed.intrinsicShortSidePairFoldTrace` shapes and that a captured
  callback trace equals the returned trace object (lines 150-159, 221-236,
  284-315) — this is the closest thing to an end-to-end integration test for
  this cluster in the unit-test suite.

Gate scripts (not `tests/`, run via `pnpm`):

- `pnpm gate:compact-nine-baselines` →
  `tsx --tsconfig tsconfig.node.json scripts/irregular-compact-nine-baselines.ts`
  (`package.json:33`). This is the 18-layout Compact/Short-Side matrix
  referenced by the migration prompt §18.6. It directly imports
  `intrinsicShortSideAxes`/`intrinsicShortSideSpan`
  (`scripts/irregular-compact-nine-baselines.ts:6-8`) and asserts, among
  other things, `guardedStage1WinnerCount === 0` and `compactFallbackCount
  === 0` as **required** conditions for the gate to pass
  (`scripts/irregular-compact-nine-baselines.ts:622-638`) — this is the
  strongest available production evidence for §15 finding 1 (the archive
  observer's ranked winner must never be the selected output) and for the
  no-Compact-fallback contract (§1). It also asserts per-fixture expected
  `shortSideCollisionIdentitySha256`, `shortSideFittedCanonicalSha256`,
  `shortSidePlacedCount`, `shortSideUnplacedCount`, and (for two fixtures)
  `shortSideMaximumCanonicalCavities`
  (`scripts/irregular-compact-nine-baselines.ts:19-181`).
- `scripts/irregular-compact-baseline.ts` — the single-case runner underlying
  the nine-baselines matrix; also imports and exercises this cluster.
- `scripts/irregular-short-side-strip-evidence.ts` and
  `scripts/irregular-short-side-shelf-probe.ts` — standalone evidence/probe
  scripts, **not** wired into `package.json` (`grep -n` over `package.json`
  finds no reference to either), so they are developer-invoked evidence
  tools, not CI/production gates. Still reference this cluster's exports and
  are worth keeping as differential-oracle fixtures during the port, but are
  not part of the required gate set from the migration prompt's §18.6 list.

No dedicated unit test file exists for `intrinsicShortSideAxes.ts` itself
(`grep -rn "intrinsicShortSideAxes(" tests/` finds no direct unit test); its
behavior is exercised only indirectly through the three observer test files
and the gate script. A Rust port's differential/unit-test plan should add a
direct axis-convention test (square sheet, `width < height`, `width >
height`) since the TS side currently relies on indirect coverage only.

## 15. Open questions and ambiguities — including places where current source contradicts widely-repeated prose

These three findings are the most important content of this document. Each
is independently source-verified (full-file reads plus `git log` commit
chronology), not inferred from docs.

### Finding 1 — the "Stage 1 archive observer" never selects the production output; it is pure telemetry

`docs/research/compact-short-side-observer.md:56-58` and its "Historical
production activation" section describe the archive observer's winner as
something that can become "the returned Short Side layout" with
`outputInfluence: 'selected'`. **In the current source,
`observeIntrinsicShortSideOrientations` always returns `outputInfluence:
'none'`** — the `'selected'` value is computed only transiently inside the
function to *measure* a hypothetical trace size for the byte-cap check
(`intrinsicShortSideObserver.ts:271-274`) and is never assigned to the object
actually returned (verified: every `return` path in the function — `:263`
in the main object literal, `:756-771` `censoredTrace` — produces
`outputInfluence: 'none'`). The caller, `computeIrregularNesting.ts:1091-1122`,
only routes the observer's winner into a benchmark hook
(`onIntrinsicShortSideObserverWinner`); it never assigns the observer's
winner to `selected` (the variable that becomes the returned layout). The
production gate `scripts/irregular-compact-nine-baselines.ts:622-638`
explicitly **requires** `guardedStage1WinnerCount === 0` for all nine
fixture/sheet pairs, i.e. the archive-observer path winning is a gate
*failure* condition, not a success condition, in the current accepted
matrix. **Rust port implication:** the archive-observer's ranking/Pareto/
admission logic in `intrinsicShortSideObserver.ts` must still be ported
byte-exactly (its `productionShortAxisSpanMm/Grid` etc. outputs feed the
pair-fold observer's admission-evidence computation, §1), and its full trace
shape must be reproducible for the diagnostic/benchmark surfaces that read
it (`onIntrinsicShortSideObserver`, gate script fields like `observerStatus`,
`selectedRotationDeg`), but **no Rust implementation should ever let this
module's ranked winner become the selected Short Side geometry** — doing so
would pass differently than current production and would need to be treated
as a regression, not a fix, even though it looks like "dead code come alive."

### Finding 2 — `evaluateIntrinsicShortSideContactStripPromotion`'s no-regression/promotion contract does not gate the selected output

`intrinsicShortSidePairFoldObserver.ts:869-877`'s own doc comment, plus
`docs/research/compact-short-side-observer.md:420-427` ("Promotion contract")
and `docs/history/compact-short-side-contact-strip.md:56-63` ("Promotion
rule"), describe the contact strip as replacing the pair-fold/shelf
incumbent **only when** it regresses none of eight named measurements and
strictly improves at least one. **In the current source, this promotion
computation (`evaluateIntrinsicShortSideContactStripPromotion`) is stored
only in the trace field `contactStripPromotion`
(`intrinsicShortSidePairFoldObserver.ts:745`) and is read nowhere else in the
file** (verified by grep: the identifier `promotion` appears only at its
`const promotion = ...` definition, `:717`, and at its one trace-field use,
`:745`). **The actual selection between the incumbent and every strip lane
is `selectDirectionalIncumbent` (§6.5)**, a different, more permissive
comparator that does not read `admission.*`, `interlocking.*` isolated/
component-count fields, or `collisionEnvelopeDensity`/material-density at
all — it compares fill tier, then (below the top fill tier) short-axis span,
then envelope area, then long-axis depth, then a topology comparator that
covers cavity count, hull-gap ratio, isolated-piece count, positive-contact-
component count, and largest-component size (§6.6), then canonical hash.
Concretely: `selectDirectionalIncumbent` **can and does** choose a
construction that regresses `collisionEnvelopeDensity` relative to the
incumbent, because density is never compared anywhere in its chain — the
"no-regression" `densityNotRegressed` term computed by
`evaluateIntrinsicShortSideContactStripPromotion` is purely descriptive.
Confirmed independently by the unit-test names in
`tests/unit/intrinsicShortSidePairFoldObserver.test.ts` ("records the
historical area bound without vetoing exact directional output", "compares
controlled promotion boundaries instead of trusting emitted flags") — the
test suite itself treats promotion as inspectable evidence, not as an
admission gate. **Rust port implication:** port
`evaluateIntrinsicShortSideContactStripPromotion` faithfully for its trace
output (it is externally observable in `intrinsicShortSidePairFoldTrace.contactStripPromotion`
and read by `scripts/irregular-compact-nine-baselines.ts`'s telemetry, though
not by its pass/fail gate logic — verify this claim doesn't have any other
untraced consumer before finalizing Rust scope), but implement the actual
selection strictly as `selectDirectionalIncumbent` (§6.5) plus
`compareDirectionalTopology` (§6.6). Do not "fix" the apparent inconsistency
by making promotion authoritative — that would change accepted production
output.

### Finding 3 — the area-cost bound (`3/4`) and the `80%`/`99%`/depth/cavity/density admission floors described at length in the research doc are historical and do not gate current acceptance

`docs/research/compact-short-side-observer.md`'s "Exact observer contract"
section (lines 60-83) and `docs/history/compact-short-side-area-cost-guard.md`
(dated 2026-07-28, i.e. today, but chronologically **superseded within the
same day** — see below) describe a multi-term admission gate including an
`80%` short-axis fill floor, a `50%` density floor, a `99%` projection-
coverage requirement, a zero-cavity requirement, and the `3/4` BigInt
area-cost bound, with a three-valued outcome space
(`short-side-satisfied-by-compact` / `short-side-quality-protected-compact-fallback`
/ `directional-miss`). **`git log` confirms the exact chronology**:
`903657e` ("guard the short-side sibling with production area-cost
honesty", 2026-07-28T00:35:05+02:00, implements exactly what
`docs/history/compact-short-side-area-cost-guard.md` describes) was
**superseded** by `951dcc3` ("make Short Side always construct directional
layouts", 2026-07-28T14:32:05+02:00) and `7009e04` ("make the small-target
continuation reproducible", 2026-07-28T14:49:20+02:00), both **after**
`903657e` on the same day, both **before** the current `HEAD`
(`f282f0a`/current tip at time of writing). In the code these two later
commits produced (i.e. what is on disk now), `finalizeOutcome`
(`intrinsicShortSidePairFoldObserver.ts:1364-1408`) computes
`admittedBesidesAreaCost` and `envelopeAreaCostWithinProductionBound` as
**evidence fields only** (feeding `envelopeAreaCostVetoes`, a diagnostic
list), while `const accepted = exactTargetIdentity` (`:1400`) is the **entire**
admission rule — a construction is accepted iff it is exactly legal (already
guaranteed by the time this function runs, since `finalizePlacedLayout`
already checked `assertCanonicalGridLegalLayout` before calling
`finalizeOutcome`, `intrinsicShortSidePairFoldObserver.ts:1208-1225`) and
places precisely the complete target piece-ID set with no duplicates/misses
(`exactTargetIdentity`, `:1359-1363`). None of fill ratio, depth,
projection coverage, cavity count, or density gates acceptance any more.
Corroborated by `grep -rn "short-side-quality-protected-compact-fallback\|
short-side-satisfied-by-compact" src/` returning **zero matches** — those
status literals do not exist anywhere in current production source; only
`grep`-confirmed in `scripts/irregular-compact-nine-baselines.ts` does a
different, simpler three-outcome model (`'missing-directional-output'` /
`'directional-success'` / `'directional-miss'`) still exist, and it treats
"missing directional output" as equivalent to "no accepted lane produced a
result," not as "a lane produced a result that failed a quality floor."
**This is the SOURCE truth the migration prompt's semantic-preservation rule
must be anchored to**: `docs/history/compact-short-side-area-cost-guard.md`,
despite its "Date: 2026-07-28" header, documents an already-superseded
intermediate state; `docs/research/compact-short-side-observer.md`'s
"Historical production activation" section (lines 30-83) is similarly
describing pre-`951dcc3` behavior and is explicitly marked elsewhere in the
same document as "chronological experiment history" that "does not define
the current production contract" (`docs/research/compact-short-side-observer.md:25-28`)
— but that self-correcting disclaimer is easy to miss because the very next
sections (30 onward) continue in present tense as if still current. **Rust
port implication:** do not implement any fill/depth/projection/cavity/
density/area-cost floor as an admission gate. Implement `exactTargetIdentity`
+ prior exact-legality as the sole acceptance rule, and implement the
area-cost bound and all quality floors solely as trace/evidence computations
matching §6.4, §6.7, and `finalizeOutcome`'s evidence block exactly.

### Other open questions (lower severity, still need orchestrator resolution before Rust implementation)

- Confirm whether `docs/artifacts/compact-short-side-directional-contract/`
  and `docs/artifacts/compact-short-side-area-cost-guard/` (referenced by the
  history docs as portable evidence copies) exist in this checkout and, if
  so, whether their manifests/hashes should become part of the Rust parity
  fixture set. Not verified in this pass (out of the four assigned files'
  direct scope, but relevant to the parity matrix another Stage-0 workstream
  is building).
  <br>Direct check: `docs/artifacts/compact-short-side-directional-contract/`
  was referenced but not opened in this session — verify its presence in a
  follow-up pass focused on the artifact/fixture inventory.
- `knowledge/compact-short-side-observer.md`, cited by the migration prompt
  (§5) as a required reading page, does **not exist** in this checkout
  (`find knowledge -iname '*short-side*'` returns nothing; the `knowledge/`
  directory itself does not exist at all). Either the prompt's pointer is
  aspirational/stale, or a `knowledge/` tree needs to be created as part of
  this migration's documentation deliverables. Flag for the orchestrator.
- The branch where `settledCompleteArchiveForShortSideObserver` stays
  `undefined` (straight capacity search with no eligible complete archive,
  `computeIrregularNesting.ts:1065-1069` vs. `:934-938`) means a Short-Side-
  requested job can silently skip this entire cluster and return a plain
  (non-directional, Compact-style) capacity result **without** raising
  `irregular_no_valid_result` and **without** any Short Side trace attached.
  Confirm with the orchestrator/user whether this is intended production
  behavior (it reads as intended, given `shortSideProfileRequested` only
  gates cluster entry when the archive observer condition at
  `:1071-1076` is met, and that condition is itself gated on
  `settledCompleteArchiveForShortSideObserver !== undefined`) or whether it
  is an existing latent gap that the Rust port must reproduce exactly
  regardless (per the semantics-preservation rule, it must be reproduced
  exactly either way — but it should be called out explicitly as a
  surprising edge case worth its own differential fixture, e.g. a Short-
  Side-profile request against a piece set that has no eligible complete
  archive at all).
- `directionalReference` (`intrinsicShortSideObserver.ts:493-558`) silently
  drops an orientation whenever `assertCanonicalGridLegalLayout` fails for
  it (`:509-517`, `flatMap` returning `[]`), and returns `undefined` overall
  if **both** q0 and q90 fail. When `productionReference` is `undefined`,
  `directionalAdmissionTerms` is also `undefined`
  (`intrinsicShortSideObserver.ts:201-208`), which — combined with Finding 1
  — has no effect on final Short Side output, but it **does** leave
  `productionShortAxisSpanMm` etc. as `undefined` on the trace, which then
  short-circuits the entire pair-fold/strip cluster invocation
  (`computeIrregularNesting.ts:1128-1139` requires all six production
  scalars to be defined before calling `observeIntrinsicShortSidePairFold`
  at all). Confirm whether "Compact's own settled placement fails exact
  legality at both q0 and q90" is a reachable production scenario (it
  shouldn't be, since Compact's own output is presumably always exactly
  legal at its own orientation, but q0/q90 *rotation* legality against the
  *requested* sheet is a different check than Compact's native-orientation
  legality) — if reachable, this is another path to a silent, traceless
  Short-Side no-op that resembles the previous bullet's gap and deserves the
  same explicit fixture treatment.
- Confirm the exact production values of
  `INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_CANDIDATE_EVALUATIONS = 2_000` and
  `INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_BACKTRACKS = 4`
  (`intrinsicShortSideContactStrip.ts:33-35`) against the migration prompt's
  §12/§18.6 lists — the prompt does not itself state these two numeric
  values, so there is no prompt-vs-source conflict to report, but they must
  be captured verbatim in the parity matrix since the prompt only names the
  mechanism ("capped contact-first strip") not its cap value.
- `INTRINSIC_SHORT_SIDE_ORDER_CONTINUATION_MAX_PIECES = 8`
  (`intrinsicShortSidePairFoldObserver.ts:40`) matches the migration prompt's
  §12 description ("for targets of at most eight pieces only") and
  `docs/history/compact-short-side-directional-only-contract.md:17` — no
  conflict, recorded here for completeness/parity-matrix traceability.
