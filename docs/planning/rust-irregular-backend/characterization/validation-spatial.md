# Characterization: validation-spatial

Stage 0 characterization for the Rust irregular-nesting port (Compact / Compact
Short Side). Cluster scope: exact translated-polygon overlap/legality
validation, the broad-phase placed-collision spatial index, the shared
orientation predicate, SAT penetration measurement, strict-convex boundary
validation, axis-aligned bounds helpers, and convex-hull construction.

Files read completely for this document (the specification surface):

- `src/workers/irregular/placementValidation.ts` (430 lines)
- `src/workers/irregular/placedCollisionSpatialIndex.ts` (261 lines)
- `src/workers/irregular/geometryPredicates.ts` (35 lines)
- `src/workers/irregular/convexSatPenetration.ts` (90 lines)
- `src/workers/irregular/convexPolygonValidation.ts` (314 lines)
- `src/workers/irregular/convexBounds.ts` (102 lines)
- `src/workers/irregular/convexHull.ts` (18 lines)
- `src/workers/irregular/core/convexHullCore.ts` (41 lines)

Files/sections read in relevant part as direct callers/callees needed to
ground liveness and call-order claims (not this cluster's primary
specification, but load-bearing for sections 1, 2, 9, 10, 13):

- `src/workers/irregular/internalGeometry.ts` (full — shared value types)
- `src/workers/irregular/services.ts` (relevant part — `ValidatePlacementInput`,
  `IrregularGeometryInputError`, `GeneratePlacementCandidatesInput`)
- `src/workers/irregular/nfpIfpService.ts` (relevant part — the dominant
  production caller of `assessPlacement`)
- `src/workers/irregular/geometryKernel.ts` (relevant part — `GeometryKernel`
  wiring of `ConvexHull.compute` and `PlacementValidation.validate`)
- `src/workers/irregular/collisionGeometryBuilder.ts` (relevant part — the
  production caller of `geometryKernel.convexHull`)
- `src/workers/irregular/core/nfpBoundaryCore.ts` (relevant part — the three
  production call sites of `computeConvexHull`, and the live NFP construction
  algorithm selector)
- `src/workers/algorithm/irregular/irregularBeamState.ts` (relevant part —
  the dominant production owner/incremental user of
  `PlacedCollisionSpatialIndex`)
- `src/workers/algorithm/irregular/windowedBeam.ts`,
  `intrinsicPeriodicCells.ts`, `intrinsicShortSideContactStrip.ts` (relevant
  parts — production call sites of `PlacementValidation.check` /
  `.checkSheetless`)
- `src/workers/algorithm/irregular/computeIrregularNesting.ts` (grep-level —
  root of the production import/DI graph used to prove liveness)
- `src/shared/irregular/domain.ts` (relevant part — field shapes for
  `IrregularPoint`, `IrregularBounds`, `IrregularPolygon`,
  `TransformedCollisionGeometry`, `IrregularPlacement`, `IrregularPlacedPiece`)
- `node_modules/robust-predicates/README.md` (confirms the y-down sign
  convention that `geometryPredicates.ts` inverts)
- `docs/history/prompts/fable5-rust-irregular-nesting-implementation.md` (sections 2,
  8, 9, 13, 14, plus 10–12 and 16 for cross-referencing constants and the
  error-mapping table)
- `docs/artifacts/linear-ring-topology/README.md` (historical performance
  provenance for the guarded linear simple-ring decision in
  `convexPolygonValidation.ts`)
- `scripts/analyze-cpu-profile.ts` (relevant part — confirms this cluster is a
  named CPU-profile category: "spatial index" and "placement validation /
  convex predicates")
- Tests read in full: `tests/unit/placementValidation.test.ts`,
  `tests/unit/placedCollisionSpatialIndex.test.ts`,
  `tests/unit/geometryPredicates.test.ts`,
  `tests/unit/convexSatPenetration.test.ts`,
  `tests/unit/convexPolygonValidation.test.ts`,
  `tests/unit/convexPolygonValidationTopology.test.ts`,
  `tests/unit/convexBounds.test.ts`
- Tests read in relevant part: `tests/unit/nfpIfpService.test.ts`,
  `tests/unit/geometryBackendParity.test.ts`

Liveness was proved by static reachability from
`src/workers/algorithm/irregular/computeIrregularNesting.ts` (the sole
Compact/Compact Short Side entry point per the migration prompt's
"Coordination and execution" file list), using both direct ES-module import
chains and Effect `Context.Tag`/`Layer` wiring (traced by grepping for the
service-tag identifier at the composition root, since Effect DI does not
appear as a static `import` edge from the consumer to the concrete
implementation module). A small Python BFS script over `from '...'` import
edges was used as a first pass and cross-checked by hand for every file in
this cluster; the raw reachable-file list is reproducible from the same
starting point and import-resolution rule (relative + `@shared/` alias).

---

## 1. Purpose and role in Compact / Compact Short Side execution

| File | Role | Live on Compact/Short Side path? |
| --- | --- | --- |
| `placementValidation.ts` | Exact translated-polygon legality check (sheet-bounds + positive-area overlap) for one candidate placement against a set of already-placed pieces. | **Yes** — dominant hot-path caller is `nfpIfpService.ts`; also reached via `windowedBeam.ts`, `intrinsicPeriodicCells.ts`, `geometryKernel.ts`. See §2. |
| `placedCollisionSpatialIndex.ts` | Persistent (functional/immutable) uniform-grid broad-phase index over already-placed pieces' translated collision polygons, used to prune the `O(placed)` scan in `placementValidation.ts` to nearby entries. | **Yes** — owned incrementally by `irregularBeamState.ts` (the beam-search state class) and by `intrinsicShortSideContactStrip.ts`. |
| `geometryPredicates.ts` | The single shared exact-sign orientation predicate (`orientation`), wrapping `robust-predicates`' `orient2d` and inverting its sign for the app's y-up DXF convention. | **Yes** — the most widely depended-on primitive in this cluster; used by `convexPolygonValidation.ts`, `placementValidation.ts`, `convexHullCore.ts`, `nfpBoundaryCore.ts`, `convexPolygonContact.ts`, `irregularLayoutScorer.ts`. |
| `convexSatPenetration.ts` | Separating-Axis-Theorem minimum-translation penetration depth between two convex polygons. | **No.** Its only two importers, `overlapRelaxation.ts` and `overlapRelaxationV1.ts`, are themselves reachable only from `intrinsicTwoPieceInterfaceReconstruction.ts`, `intrinsicDetachedPieceReinsertion.ts`, and `targetedExactLns.ts` — none of which has any non-test importer anywhere in `src/`, and none of which is imported (directly or via a `Context.Tag`/`Layer` reference) by `computeIrregularNesting.ts`. This is a dead/orphaned experimental island reachable only from its own five files and their unit tests. See evidence below. |
| `convexPolygonValidation.ts` | Strict-convex, simple-ring, finite-coordinate boundary validator (`validateStrictBoundary`) that is the sole gate for "is this a legal v2 collision polygon" everywhere in the pipeline. | **Yes** — used by `placementValidation.ts`, `placedCollisionSpatialIndex.ts`, `nfpBoundaryCore.ts`, `transformCollisionGeometryCore.ts`, `ifpBoundsCore.ts`, `transformGenerator.ts`, `nfpIfpService.ts`, `freeMaterialService.ts`, `clipper2OffsetAdapter.ts`, `convexPolygonOffset.ts`. |
| `convexBounds.ts` | Axis-aligned bounds computation (`boundsForPoints`), translate-and-rebound (`translatePolygonWithBounds`), and strict-separation broad-phase test (`areDisjoint`). | **Yes** — used by `placementValidation.ts`, `placedCollisionSpatialIndex.ts`, `nfpIfpService.ts`, `convexPolygonContact.ts`, `irregularPlacementScorer.ts`, `intrinsicPeriodicCells.ts`. |
| `convexHull.ts` | Thin domain-object wrapper (`ConvexHull.compute`) around `convexHullCore.ts`, converting `IrregularPoint[]` in/`IrregularPolygon` out. | **Yes** — the sole implementation bound to `GeometryKernel.Live`'s `convexHull` operation (`geometryKernel.ts:170`), called from `collisionGeometryBuilder.ts:73` to build every piece's source convex hull during collision-geometry preparation. |
| `core/convexHullCore.ts` | Structural monotone-chain convex hull (`computeConvexHull`) with no domain-object dependency. | **Yes**, and more centrally than `convexHull.ts` alone suggests: it is also called directly by `nfpBoundaryCore.ts` at three sites (`nfpBoundaryCore.ts:272,352,487`), including as **the live default NFP-boundary construction algorithm** (see §2). |

**Dead-code evidence for `convexSatPenetration.ts`:**

```
$ grep -rln "from '.*/overlapRelaxation\.js'" src --include='*.ts' | grep -v '\.test\.'
src/workers/algorithm/irregular/intrinsicTwoPieceInterfaceReconstruction.ts
src/workers/algorithm/irregular/overlapRelaxationV1.ts
src/workers/algorithm/irregular/intrinsicDetachedPieceReinsertion.ts
src/workers/algorithm/irregular/targetedExactLns.ts

$ grep -rln "from '.*/(overlapRelaxationV1|targetedExactLns|intrinsicTwoPieceInterfaceReconstruction|intrinsicDetachedPieceReinsertion)\.js'" src --include='*.ts' | grep -v '\.test\.'
(no output — none of these four files has any non-test importer)

$ grep -c "TwoPieceInterfaceReconstruction\|DetachedPieceReinsertion\|TargetedExactLns\|OverlapRelaxation" \
    src/workers/algorithm/irregular/computeIrregularNesting.ts
0
```

`computeIrregularNesting.ts` is 1920 lines and is the sole entry point
imported by `src/workers/nesting.worker.ts` for irregular jobs (per the
migration prompt's "Coordination and execution" file list). It references
none of the five island files by name, by type, or by `Context.Tag`. The
island's only references anywhere in `src/` are internal to the five files
themselves; its tests (`tests/unit/overlapRelaxation.test.ts`,
`overlapRelaxationTracker.test.ts`, `targetedExactLns.test.ts`,
`convexSatPenetration.test.ts`) exercise it in isolation and never touch
`computeIrregularNesting.ts`, `portfolioSearch.ts`, `windowedBeam.ts`, or any
other module reachable from the production entry point. This matches the
migration prompt's §10.11 caution about "observer and shadow-only modules"
remaining non-authoritative — except this island is stronger than
"non-authoritative observer": it has **zero** production call sites, live or
shadow.

Contrast: `intrinsicQueueBeamDiscriminator.ts`, `strictPriorityDecoder.ts`,
`intrinsicComponentInterfaceClosure.ts` are three more files that reference
this cluster (`placementValidation.ts` and/or `convexBounds.ts`) but are
themselves unreachable from `computeIrregularNesting.ts` by the same test
(zero non-test importers). They do not change any liveness verdict in the
table above because every other importer of `placementValidation.ts` and
`convexBounds.ts` is independently live.

**Hot-path evidence (why this cluster matters for a Rust port):**
`scripts/analyze-cpu-profile.ts:59-70` defines dedicated CPU-profile
categories `spatial index` (matches `placedCollisionSpatialIndex`) and
`placement validation / convex predicates` (matches `placementValidation`,
`convexPolygon*`, `convexSat*`) for `pnpm profile:mixed61` output —
confirming this cluster is treated as a first-class cost center in existing
performance instrumentation, distinct from NFP/IFP generation and from
canonical-key/beam-state cost. Separately,
`docs/artifacts/linear-ring-topology/component-measurements.json` (summarized
in `docs/artifacts/linear-ring-topology/README.md`) measured the guarded
linear simple-ring decision inside `convexPolygonValidation.ts` (see §7) at
`854.2ms → 514.1ms` of one Mixed-61 run (`0.79%` of total run time saved),
and recorded that "the rings actually validated on the hot path are small,
`97%` at eight vertices or fewer and none above sixteen" — directly relevant
to §13's parallelism assessment (tiny per-call N).

---

## 2. Entry points, callers, callees

### `placementValidation.ts`

Public surface: `PlacementValidation.check`, `PlacementValidation.checkSheetless`,
`PlacementValidation.validate` (all Effect-wrapped), and the raw synchronous
`assessPlacement` (exported separately, not part of the `PlacementValidation`
object).

- `assessPlacement(input, enforceSheetBounds)` — pure function, never
  suspends (`placementValidation.ts:61-69` docstring: "The geometry here
  never suspends... wrapping it in `Effect` cost one effect construction and
  one fiber step per point for no benefit"). Called directly (bypassing
  `Effect`) from `nfpIfpService.ts:532-534`, once per canonical candidate
  point per alternative, inside `generatePlacementCandidates`'s hot loop
  (`nfpIfpService.ts:495-554`). This is the **dominant production call
  site** by call volume: every legal-placement candidate generated for every
  NFP-derived point in Compact and Compact Short Side search goes through
  this call.
- `PlacementValidation.check` (Effect wrapper, `enforceSheetBounds=true`) —
  live production callers: `windowedBeam.ts:1298` (validating an "exact
  incumbent placement reserved for reconstruction lineage" candidate, passing
  `input.state.placedCollisionIndex` through explicitly). Dead callers (see
  §1): `overlapRelaxation.ts:536`, `overlapRelaxationV1.ts:1080`,
  `intrinsicTwoPieceInterfaceReconstruction.ts:348`, `targetedExactLns.ts:132`.
- `PlacementValidation.checkSheetless` (Effect wrapper, `enforceSheetBounds=false`,
  input type omits `sheet`) — live production callers: four call sites in
  `intrinsicPeriodicCells.ts` (lines 479, 755, 1455, 1979), each validating a
  sheetless (pre-fit) periodic-cell candidate placement against one or two
  already-placed pieces before deriving a cell. Dead caller:
  `intrinsicQueueBeamDiscriminator.ts` (lines 3027, 3244).
- `PlacementValidation.validate` (Effect wrapper, throws
  `IrregularGeometryInputError` on illegal placement instead of returning
  `false`) — wired as `GeometryKernel.Live`'s `validatePlacement` operation
  (`geometryKernel.ts:191`). **No production caller invokes
  `kernel.validatePlacement(...)` anywhere in `src/`** (`grep -rn
  "\.validatePlacement(" src --include='*.ts' | grep -v '\.test\.'` returns
  nothing). It is exercised only by
  `tests/unit/placementValidation.test.ts:291-303` ("is the validator used by
  `GeometryKernel.Live`"), which asserts the wiring itself, not a production
  code path. Treat this operation as a tested public-API contract with no
  current production traffic, not as dead code — the `GeometryKernel.Service`
  interface is the class's public surface and a Rust `GeometryKernel`-shaped
  boundary may still need an equivalent for interface parity even though no
  Compact/Compact Short Side job reaches it today.

Callees: `convexPolygonValidation.ts` (`ConvexPolygonValidation.validateStrictBoundary`),
`convexBounds.ts` (`areDisjoint`, `translatePolygonWithBounds`),
`geometryPredicates.ts` (`GeometryPredicates.orientation`), and (via the
`placedCollisionIndex` optional field) `placedCollisionSpatialIndex.ts`'s
`.matches()` and `.query()` instance methods.

### `placedCollisionSpatialIndex.ts`

Public surface: `makeEmptyPlacedCollisionSpatialIndex`,
`makePlacedCollisionSpatialIndex`, and the `PlacedCollisionSpatialIndex`
interface (`size`, `cellSizeMm`, `entries`, `add`, `matches`, `query`,
`continuationIdentity`).

- Owned incrementally by `irregularBeamState.ts` — `IrregularBeamState`'s
  constructor (`irregularBeamState.ts:120-124`) reuses a passed-in index only
  if `placedCollisionIndex.matches(this.placedCollisionGeometries)`,
  otherwise rebuilds via `makePlacedCollisionSpatialIndex`.
  `withPlacement` (`irregularBeamState.ts:193`) calls
  `this.placedCollisionIndex.add(input.placedCollisionGeometry)` once per
  incremental placement — this is the primary production write path.
  `withBottomLeftAnchored` (`irregularBeamState.ts:320`) and two more sites
  (`irregularBeamState.ts:440,537,544`) rebuild via
  `makePlacedCollisionSpatialIndex` from scratch (e.g., after a rigid
  coordinate shift, since translation invalidates cached translated bounds).
- `intrinsicShortSideContactStrip.ts:247` starts from
  `makeEmptyPlacedCollisionSpatialIndex()` and presumably grows it similarly
  for Compact Short Side's independent directional construction (this
  file's own incremental-growth logic belongs to a different cluster; only
  its call into `placedCollisionSpatialIndex.ts`'s public API is in scope
  here).
- `strictPriorityDecoder.ts:93` also calls
  `makeEmptyPlacedCollisionSpatialIndex()`, but `strictPriorityDecoder.ts`
  itself has no non-test importer (dead, per §1) — noted for completeness,
  not a liveness claim.
- All production call sites use the **default** cell size
  (`DEFAULT_PLACED_COLLISION_GRID_CELL_SIZE_MM = 64`,
  `placedCollisionSpatialIndex.ts:9`); no production call site overrides
  `cellSizeMm` (only tests do, e.g. `placedCollisionSpatialIndex.test.ts:94`
  uses `4`).

Callees: `convexPolygonValidation.ts` (`ConvexPolygonValidation.validateStrictBoundary`),
`convexBounds.ts` (`translatePolygonWithBounds`), plus a locally re-declared
`areDisjoint` (see §12 — this file does **not** import `areDisjoint` from
`convexBounds.ts`; it has its own byte-identical copy at
`placedCollisionSpatialIndex.ts:254-261`).

### `geometryPredicates.ts`

Single export `GeometryPredicates.orientation`. Direct importers (live):
`convexPolygonValidation.ts`, `placementValidation.ts`, `core/convexHullCore.ts`,
`nfpIfpService.ts`, `core/nfpBoundaryCore.ts`, `convexPolygonContact.ts`,
`irregularLayoutScorer.ts`. Every polygon-topology decision in the live
Compact/Compact Short Side path ultimately bottoms out in this one function's
sign.

### `convexSatPenetration.ts`

Single export `measureConvexSatPenetration`. No live callers (§1). Its two
callers are `overlapRelaxation.ts:proposeSlideResolution`-style usage and
`overlapRelaxationV1.ts`, both part of the dead LNS/overlap-relaxation
island.

### `convexPolygonValidation.ts`

Single export `ConvexPolygonValidation.validateStrictBoundary`. Callees:
`geometryPredicates.ts` only. Live callers listed in §1's table; the two
richest production call chains are (a) every placed/moving polygon
translation in `placementValidation.ts` and
`placedCollisionSpatialIndex.ts`'s `makeEntry`, and (b) every NFP/IFP
boundary construction and cache-hit revalidation in `nfpBoundaryCore.ts`
(`isValidCachedNfpBoundary`, `computeRelativeNfpBoundaryReference`,
`computeRelativeNfpBoundaryLinear`, `translateNfpBoundary`'s hull fallback).

### `convexBounds.ts`

Exports `boundsForPoints`, `translatePolygonWithBounds`, `areDisjoint`.
Callees: none (leaf module; only depends on `internalGeometry.ts` types).
Live callers listed in §1's table.

### `convexHull.ts` / `core/convexHullCore.ts`

- `convexHull.ts` exports `ConvexHull.compute(points: IrregularPoint[]):
  IrregularPolygon`, a thin adapter that calls `computeConvexHull` from
  `core/convexHullCore.ts` and wraps the result in the domain
  `IrregularPolygon` class. Its only live caller is
  `geometryKernel.ts:170` (`convexHull: (points) =>
  Effect.succeed(ConvexHull.compute(points))`), which is in turn called from
  `collisionGeometryBuilder.ts:73` (`yield* geometryKernel.convexHull(flattened.sampledPoints)`)
  — one call per imported piece, during the one-time collision-geometry
  preparation phase (not per candidate/per search step).
- `core/convexHullCore.ts` exports `computeConvexHull(points:
  InternalPoint[]): InternalPolygon`, structural (no domain-class
  dependency). Callees: `geometryPredicates.ts` only. Live callers:
  `convexHull.ts` (above) and **three direct call sites in
  `nfpBoundaryCore.ts`**:
  - `nfpBoundaryCore.ts:272` — inside `computeRelativeNfpBoundaryReference`,
    on the full pairwise Minkowski-sum point set (`fixedPoints.length ×
    movingPoints.length` points). This function is selected whenever
    `constructionAlgorithm !== 'linear-edge-merge'`
    (`nfpBoundaryCore.ts:174-176`), and the module-level default,
    `DEFAULT_NFP_CONSTRUCTION_ALGORITHM = 'vertex-pair-hull'`
    (`core/nfpCacheKey.ts:7`), selects exactly this branch. **This makes
    `computeConvexHull` the live, default, production NFP-boundary
    construction algorithm for every pairwise NFP computed by Compact and
    Compact Short Side**, not merely a fallback. `nfpIfpService.ts:104-107`'s
    docstring corroborates this explicitly: "The pairwise vertex-sum hull
    construction is the live default and differential correctness oracle,"
    contrasting it with the alternate `'linear-edge-merge'` O(n+m)
    edge-direction merge (`computeRelativeNfpBoundaryLinear`,
    `nfpBoundaryCore.ts:278`), which is not the default.
  - `nfpBoundaryCore.ts:352` — inside `computeRelativeNfpBoundaryLinear`, as
    a fallback only when the linear edge-merge's fast ring canonicalization
    (`canonicalizeTranslatedConvexRing`) fails; this branch only executes
    when `constructionAlgorithm === 'linear-edge-merge'` is explicitly
    selected, which no production caller does.
  - `nfpBoundaryCore.ts:487` — inside
    `canonicalizeTranslatedConvexRingWithHullFallback`, called from
    `translateNfpBoundary` (`nfpBoundaryCore.ts:465-482`) whenever the fast
    translated-ring canonicalization fails after applying the fixed piece's
    placement translation to an already-computed relative NFP boundary. This
    path is algorithm-independent (reached regardless of
    `constructionAlgorithm`) and is exercised whenever translation pushes the
    ring's stable-start rotation or exact-arithmetic assumptions outside the
    fast path's guarantees.

  `geometryBackendParity.test.ts:289-331` differentially tests
  `'linear-edge-merge'` against `'vertex-pair-hull'` NFP output for parity,
  which is the test-level guarantee that `computeConvexHull`'s live-default
  output is behaviorally interchangeable (for valid inputs) with the
  alternate algorithm — see §14.

`computeConvexHull` performs **no finiteness validation of its own** (no
`Number.isFinite` guard anywhere in `core/convexHullCore.ts`). Every current
caller guarantees finite input before calling it: `collisionGeometryBuilder.ts`
via `ArcFlattening`/`EllipseFlattening` sampling; `nfpBoundaryCore.ts`'s three
call sites via `sumPoints(...)` (Minkowski sum) or `translateNfpBoundary`'s
own `Number.isFinite` checks before pushing each translated point. A Rust
port must preserve this "caller-guaranteed finite input, no defensive check
inside the hull function" contract rather than adding a finiteness guard
that TypeScript does not have (see §12).

---

## 3. Data in/out: exact types/shapes, optional-field presence/omission semantics

### `internalGeometry.ts` value types (shared foundation, `internalGeometry.ts:1-20`)

```ts
interface InternalPoint { readonly x: number; readonly y: number }
interface InternalBounds { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }
interface InternalPolygon { readonly points: ReadonlyArray<InternalPoint> }
interface InternalPolygonWithBounds { readonly polygon: InternalPolygon; readonly bounds: InternalBounds }
```

All numeric fields are plain JS `number` (binary64). No `BigInt` appears
anywhere in this cluster's own types or in the domain types it consumes
(`IrregularPoint`, `IrregularBounds`, `IrregularPolygon`,
`TransformedCollisionGeometry`, `IrregularTransform`,
`IrregularTransformCandidate`, `IrregularPlacement`, `IrregularPlacedPiece` —
all confirmed plain-`number`/`boolean`/`string` fields in
`src/shared/irregular/domain.ts:139-735`).

### `ValidatePlacementInput` (`services.ts:206-213`)

```ts
interface ValidatePlacementInput {
  readonly sheet: SheetSpec
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly placedCollisionIndex?: PlacedCollisionSpatialIndex
  readonly moving: TransformedCollisionGeometry
  readonly candidate: IrregularPlacementCandidate
}
```

- `sheet` is **absent by type**, not merely `undefined`, in the
  `checkSheetless`/sheetless-`assessPlacement` call shape
  (`Omit<ValidatePlacementInput, 'sheet'>` — `placementValidation.ts:40-44`).
  `assessPlacement` tests presence with the `in` operator
  (`'sheet' in input`, `placementValidation.ts:124`), not
  `input.sheet !== undefined` — genuine key-presence semantics, not a
  nullable-value semantics. In practice this only matters defensively: both
  call sites that reach the `enforceSheetBounds && 'sheet' in input` branch
  with `enforceSheetBounds=true` are statically typed to require `sheet`
  (`check`/`validate`), so the `'sheet' in input` half of the conjunction is
  always true when reached; `checkSheetless` always passes
  `enforceSheetBounds=false`, short-circuiting before the `in` test runs. A
  Rust port modeling this as `Option<Sheet>` plus a separate
  `enforce_sheet_bounds: bool` parameter is behaviorally equivalent as long
  as both are threaded through identically (do not collapse them into one
  flag — see §12).
- `placedCollisionIndex` is a genuinely optional field whose **presence**
  changes control flow, not just performance: when present *and*
  `spatialIndex.matches(input.placed)` returns true, `assessPlacement` takes
  the indexed-lookup branch (`placementValidation.ts:86-103`); otherwise it
  takes the brute-force per-`placed`-piece branch
  (`placementValidation.ts:104-120`). Both branches are proven to return
  identical legality results by `tests/unit/placedCollisionSpatialIndex.test.ts:145-168`
  ("matches direct validation across contacts, overlaps, and disjoint
  candidates").
- `candidate.point` is read structurally (`.x`, `.y` only); in production it
  is actually a `CanonicalCandidatePoint` (`nfpIfpService.ts:562-566`, a
  different cluster's type) carrying extra `squaredDistance`, `gridX`,
  `gridY` fields that `assessPlacement` never reads — safe under TypeScript's
  structural typing, and a Rust port using an exact `struct Point { x: f64, y:
  f64 }` parameter type (rather than reusing a richer candidate struct) is
  equally safe as long as the caller supplies the same `x`/`y`.

### `assessPlacement` return shape (`placementValidation.ts:70-73`)

```ts
function assessPlacement(
  input: ValidatePlacementInput | Omit<ValidatePlacementInput, 'sheet'>,
  enforceSheetBounds: boolean
): PlacementAssessment | { readonly failure: IrregularGeometryInputError }

interface PlacementAssessment { readonly legal: boolean; readonly message: string }
```

A three-way outcome encoded as a two-shape discriminated union tested with
`'failure' in assessment`:
1. **Geometry failure** (`{ failure: IrregularGeometryInputError }`) — a
   typed, non-recoverable error (non-finite translation, invalid polygon
   topology found while translating/validating either the moving polygon or
   any placed polygon, or an interior-point/side arithmetic failure that in
   practice cannot be reached given upstream invariants — see §11).
2. **Legal** (`{ legal: true, message: '' }`) — `message` is always the
   literal empty string on success (`placementValidation.ts:143`); no
   caller reads this field on the legal path.
3. **Illegal** (`{ legal: false, message: <one of several fixed strings> }`)
   — a normal, expected outcome for candidate filtering, not an error (per
   the docstring at `placementValidation.ts:26-33`).

### `PlacedCollisionSpatialIndex` (`placedCollisionSpatialIndex.ts:26-34`)

```ts
interface PlacedCollisionSpatialIndex {
  readonly size: number
  readonly cellSizeMm: number
  readonly entries: ReadonlyArray<PlacedCollisionSpatialEntry>
  readonly add: (placed: IrregularPlacedPiece) => PlacedCollisionSpatialIndex
  readonly matches: (placed: ReadonlyArray<IrregularPlacedPiece>) => boolean
  readonly query: (bounds?: InternalBounds) => ReadonlyArray<PlacedCollisionSpatialEntry>
  readonly continuationIdentity: () => string
}

interface PlacedCollisionSpatialEntry {
  readonly placed: IrregularPlacedPiece
  readonly translated: IndexedPlacedCollisionPolygon | undefined
  readonly validationMessage: string | undefined
  readonly indexedBounds: InternalBounds | undefined
  readonly ordinal: number
}
```

`translated`/`validationMessage`/`indexedBounds` are a three-way-coupled
optional group, not three independent optionals: exactly one of
(`translated` defined, `validationMessage` undefined, `indexedBounds`
defined) or (`translated` undefined, `validationMessage` defined,
`indexedBounds` undefined) ever occurs (`makeEntry`,
`placedCollisionSpatialIndex.ts:159-195`). A Rust port should model this as
a single `Result<ValidEntry, String>`-shaped enum, not three
`Option<T>` fields, to make the coupling structurally enforced rather than a
convention.

### `ConvexPolygonValidation.validateStrictBoundary` return shape (`convexPolygonValidation.ts:15-33`)

```ts
type StrictConvexBoundaryValidation =
  | { readonly winding: -1 | 1 }
  | { readonly message: string }
```

`ConvexPolygonWinding = -1 | 1` never `0` — a validated ring always has a
determined, non-zero, consistent winding.

### `measureConvexSatPenetration` return shape (`convexSatPenetration.ts:1-13`, dead code)

```ts
interface ConvexSatPenetration { readonly depth: number; readonly translation: InternalPoint }
function measureConvexSatPenetration(first, second): ConvexSatPenetration | undefined
```

`undefined` means "no positive penetration" (separated or exactly touching);
it is not distinguished from "penetration depth exactly zero" — both produce
`undefined` (`negativeDepth <= 0 || positiveDepth <= 0` returns `undefined`
at `convexSatPenetration.ts:24`, using `<=` not `<`).

---

## 4. Algorithm state and every mutation point

**None of these eight files performs any true in-place mutation of shared
state.** Every function is either a pure computation over its arguments, or
a factory that constructs and returns a brand-new object while leaving all
inputs untouched. This is a specification property, not an incidental
implementation detail — it is what makes `PlacedCollisionSpatialIndex` safe
to use for beam-search backtracking (see below and §13).

- **`convexHullCore.ts`, `geometryPredicates.ts`, `convexBounds.ts`,
  `convexPolygonValidation.ts`, `convexSatPenetration.ts`**: entirely pure;
  no module-level mutable state, no closures over mutable variables that
  outlive a single call.
- **`placementValidation.ts`**: pure; `assessPlacement` builds local arrays
  (`placedPolygons`) and returns; no field of any input object is ever
  assigned.
- **`placedCollisionSpatialIndex.ts`**: the `UniformPlacedCollisionSpatialIndex`
  class holds `readonly` fields only
  (`placedCollisionSpatialIndex.ts:57-62`); every "mutating" operation is
  actually a factory producing a new instance that structurally shares
  immutable data with, but never mutates, its parent:
  - `add(placed)` (`placedCollisionSpatialIndex.ts:77-104`): computes one new
    `entry` (via `makeEntry`, itself pure); builds `entries = [...this.entries,
    entry]` (new array, O(n) copy); builds `buckets = new Map(this.buckets)`
    (new `Map`, O(bucket-key count) shallow copy of key→array-reference
    pairs); for each grid cell the new entry's bounds touch, replaces that
    cell's bucket array with `[...bucket, entry]` (new array, O(bucket
    length) copy) via `buckets.set(key, ...)` on the **new** local `buckets`
    Map — the parent's `buckets` Map object is never touched, and the
    parent's per-cell array *references* inside its own (distinct) `buckets`
    Map are never mutated either, since each cell update replaces the array
    rather than pushing into it. Returns a new
    `UniformPlacedCollisionSpatialIndex`. **Cost is `O(n + fan-out ×
    bucket-length)` per call**, i.e. `add`-ing to a beam-search state with
    many already-placed pieces re-copies the entire `entries` array and the
    entire `buckets` `Map`'s key set every time — this is the concrete
    performance target implied by the "spatial index" CPU-profile category
    in §1, and a legitimate Stage 3/4 target for a cheaper Rust persistent
    structure, provided the exact same `query`/`matches`/`continuationIdentity`
    outputs are reproduced (migration prompt §1: "The only accepted
    externally observable improvement is reduced execution time").
  - `query(bounds)` (`placedCollisionSpatialIndex.ts:129-156`): read-only;
    builds and returns a new filtered array; never mutates `this`.
  - `matches(placed)` (`placedCollisionSpatialIndex.ts:106-116`): read-only
    boolean predicate; **reference-identity** comparison per index
    (`entry.placed !== placedPiece`, `!==` on object references, not a
    structural/deep-equality comparison) — see §12.
  - `continuationIdentity()` (`placedCollisionSpatialIndex.ts:118-127`):
    read-only; builds a canonical JSON string; never mutates `this`.
  - `makeEmptyPlacedCollisionSpatialIndex`/`makePlacedCollisionSpatialIndex`
    (`placedCollisionSpatialIndex.ts:36-54`): the latter is literally a
    left-fold: `let index = makeEmpty(...); for (const p of placed) index =
    index.add(p); return index` — **this makes bulk construction from `n`
    placed pieces `O(n²)` in the worst case** (each of the `n` sequential
    `add` calls copies an `entries` array whose length grows from 0 to `n`),
    matching the same asymptotic concern as incremental `add` above.
- **`convexHull.ts`**: pure; delegates to `computeConvexHull` and wraps in a
  new `IrregularPolygon`.

**Consuming state, not owned here:** `irregularBeamState.ts` (a different
cluster) is the actual owner of the beam-search state graph in which
`PlacedCollisionSpatialIndex` instances are embedded and chained via
parent/child references for backtracking (`irregularBeamState.ts:118`,
`this.parent = input.parent`). This cluster's files never construct or
inspect that parent chain themselves.

---

## 5. Ordering sources

1. **`convexHullCore.ts:6-9`** — `[...points].sort((left, right) => left.x
   !== right.x ? left.x - right.x : left.y - right.y)`. Ascending by `x`
   then `y`. `Array.prototype.sort` is spec-guaranteed stable since ES2019
   (V8 has implemented this since Node 11); ties (`left.x === right.x &&
   left.y === right.y`, i.e. exact duplicate coordinates) preserve original
   relative order, but since `InternalPoint` carries no observable field
   beyond `x`/`y`, stability has no externally observable effect here (any
   two "equal" points are interchangeable). Preserve stable sort anyway for
   defensive parity with the general JS-sort-stability rule the migration
   prompt calls out (§9 of the prompt).
2. **`convexHullCore.ts:18-26`** (`deduplicateSortedPoints`) — walks the
   sorted array once, keeping a point only if it differs from
   `uniquePoints.at(-1)`; this is an ordering *consumer*, not source: it
   depends on the sort above already being in place.
3. **`convexHullCore.ts:5-16`** (`computeConvexHull`) — builds `lowerHull`
   from ascending-sorted points and `upperHull` from the same array
   reversed, each via `buildHullHalf`
   (`convexHullCore.ts:28-41`), which is a strictly sequential
   left-to-right scan with a backtracking `while` loop (pop while the last
   three points do not turn left, i.e. `orientation(...) <= 0`). Final
   result order is `[...lowerHull.slice(0,-1), ...upperHull.slice(0,-1)]` —
   a specific, deterministic starting vertex and winding
   (counter-clockwise, per `convexHull.ts:9-13`'s docstring) that downstream
   canonicalization (`rotateToStableStart` in `nfpBoundaryCore.ts`, a
   different cluster) further normalizes.
4. **`placedCollisionSpatialIndex.ts:61,80`** — the `buckets:
   ReadonlyMap<string, ReadonlyArray<...>>` field. `Map` insertion order in
   V8 is preserved but **is never iterated for output** in `query()`
   (`placedCollisionSpatialIndex.ts:129-156`): `query` builds a `Set` from
   bucket contents purely for O(1) membership testing
   (`selected.has(entry)`), then produces its final return value by
   filtering `this.entries` (a plain array in fixed, insertion/ordinal
   order) — see item 6. **`Map`/`Set` iteration order therefore does not
   reach `query()`'s output.** This is worth stating explicitly because it
   is the one place in this cluster where a naive port might over-correct
   (e.g. by needlessly sorting bucket contents) where the source does not.
5. **`placedCollisionSpatialIndex.ts:118-127`** (`continuationIdentity`) —
   **is** an ordering source that reaches an observable string: `[...this.
   buckets.entries()].map(...).toSorted(([first], [second]) =>
   first.localeCompare(second))`. This explicitly re-sorts the `Map`'s
   entries by `String.prototype.localeCompare` on the `cellKey` string
   (`"${cellX}:${cellY}"`), specifically to make the output independent of
   `Map` insertion order — but see §6 and §12 for why `localeCompare` itself
   is a hazard distinct from the Map-order problem it is trying to solve.
6. **`placedCollisionSpatialIndex.ts:147-155`** (`query`'s final `return`)
   — `this.entries.filter(...)`. `entries` is a plain, append-only array
   built in strict call order of `.add()` (or the single left-fold in
   `makePlacedCollisionSpatialIndex`); its order is therefore exactly
   "ordinal order," i.e. the order placed pieces were incrementally added to
   this specific index instance. This is the **authoritative output order**
   of `query()` and, transitively, of the `placedPolygons` array
   `assessPlacement` builds from indexed entries
   (`placementValidation.ts:90-103`) — which matters because
   `polygonsHavePositiveAreaOverlap` (§6) is evaluated per placed polygon in
   that exact order with early-exit, so ordinal order can affect *which*
   diagnostic path is taken first (though not the final boolean, given the
   invariants in §13).
7. **`placementValidation.ts:105-119`** (the non-indexed brute-force branch)
   — iterates `input.placed` in the caller-supplied array order, unchanged.
   Both branches (indexed and brute-force) are required to and proven to
   (`tests/unit/placedCollisionSpatialIndex.test.ts:145-168`) produce
   identical legality results, but the *order* in which individual placed
   pieces are checked can differ between the two branches for the same
   logical input (ordinal/insertion order in the indexed branch vs.
   caller-array order in the brute-force branch) — these coincide today
   because `input.placed` is always the same array the index was built from,
   in the same order, but this is a caller invariant, not something these
   two files enforce on each other structurally.
8. **`convexPolygonValidation.ts`** — no sorting; iteration is always in
   input point/edge order (`for (let index = 0; index < points.length; ...)`),
   deterministic and caller-order-preserving throughout.
9. **`convexSatPenetration.ts:17`** (dead code) — `[...polygonAxes(first),
   ...polygonAxes(second)]`: axis candidates are enumerated in `first`'s
   edge order then `second`'s edge order; the minimum-penetration search
   over this fixed sequence uses the tie-break comparator in §6.

---

## 6. Comparators and tie rules

- **`geometryPredicates.ts:16-35`** (`orientation`) is the base three-way
  sign predicate everything else composes: `orient2d(origin, first, second)`
  from `robust-predicates` (exact/adaptive-precision, y-down convention per
  the library's own README) is **sign-inverted** before returning: `>0 →
  -1`, `<0 → 1`, `0 → 0`. In this codebase's convention, `+1` = left turn /
  counter-clockwise in y-up DXF space, `-1` = right turn, `0` = collinear.
  This inversion is applied at exactly one place; every other function in
  this cluster and its live callers treats `orientation`'s return value as
  already being in y-up convention and never re-inverts.
- **`convexPolygonValidation.ts:161-188`** (`scanTurns`) — walks each vertex
  and computes `orientation(previous, current, next)`. Tie/failure rule
  ordering, in the exact order checked: (1) any `turn === 0` at any vertex →
  immediate failure `'polygon must not contain collinear vertices.'`
  (`convexPolygonValidation.ts:174-176`) — **collinearity is never treated
  as a tie to resolve; it is unconditionally rejected**; (2) the first
  non-zero turn observed sets `winding` for the whole ring; (3) any
  subsequent turn that disagrees with the established `winding` →
  `'polygon must be strictly convex with one consistent winding.'`
  (`convexPolygonValidation.ts:183-185`). Because the loop returns at the
  *first* vertex that fails, the reported diagnostic message and (via
  `TurnScan.winding`, used to decide the message in `hasSelfIntersection`
  fallback selection at `convexPolygonValidation.ts:101-107`) even control
  flow depend on vertex scan order — this order is always the caller-given
  polygon vertex order (not sorted), so it is fully deterministic and needs
  no additional tie-break for a Rust port beyond preserving the identical
  scan-and-first-failure-wins loop.
- **`convexPolygonValidation.ts:60-116`** (`validateStrictBoundary`'s
  overall diagnostic precedence) — checked in this exact order regardless of
  which check would "naturally" fail first geometrically: (1) vertex count
  `< 3`; (2) any non-finite coordinate; (3) any repeated adjacent vertex
  (`start.x === end.x && start.y === end.y`, exact equality, no tolerance);
  (4) simple-ring self-intersection (via one of two implementations — see
  §7's guarded linear-topology decision); (5) turn-scan failures (collinear
  vertex / inconsistent winding) — **but note the code comment at
  `convexPolygonValidation.ts:96`, "the turn scan runs first, but crossing
  diagnostics still take precedence"**: `scanTurns` is *computed* before the
  self-intersection check in program order, but its failure message is only
  *returned* after the self-intersection check has already passed
  (`convexPolygonValidation.ts:97-109`), so a ring that both self-intersects
  and has an inconsistent-winding turn always reports the self-intersection
  message, never the turn message. This exact precedence is pinned
  byte-for-byte by `tests/unit/convexPolygonValidationTopology.test.ts:337-350`
  ("reports a crossing ahead of the turn failure it also has"). (6) zero
  total winding (`turnScan.winding === undefined`, only reachable for
  self-intersection-free rings whose turn scan somehow never set a winding —
  in practice unreachable for `length >= 3` after the above checks, but
  written defensively, matching the pattern noted in §13).
- **`convexSatPenetration.ts:31-37`** (dead code) — the "best" SAT axis
  selection is a genuine two-level tie-break over the fixed axis-enumeration
  order from §5 item 9: primary key `depth` (strictly smaller wins,
  `depth < best.depth`), secondary key `translation` compared via
  `comparePoint` (`convexSatPenetration.ts:82-86`: compare `.x` ascending,
  then `.y` ascending, both via `!==`/`<` on raw numbers, no epsilon) when
  `depth === best.depth` exactly (IEEE-754 exact equality, not
  approximate). First axis in enumeration order wins all-else-equal only if
  no later axis's translation compares strictly less by `comparePoint` — so
  strictly speaking this is *not* first-wins-on-tie, it is
  smallest-translation-wins-on-depth-tie, with axis enumeration order only
  breaking a `comparePoint` tie implicitly via loop order (`best === undefined
  || ...`, so the very first candidate always becomes `best` and is only
  replaced by a strictly smaller one).
- **`placementValidation.ts:191-234`** (`polygonsHavePositiveAreaOverlap`)
  is a strict *ordered sequence* of independent tests, each of which can
  short-circuit the whole function to `{ value: true }`, in this exact
  order: (1) `areDisjoint` broad-phase bounds check → `false`; (2) any point
  of `first` strictly inside `second` → `true`; (3) any point of `second`
  strictly inside `first` → `true`; (4) any proper boundary crossing → `true`;
  (5) either polygon's equal-weight-vertex-average interior point strictly
  inside the other → `true`; (6) any positive-length collinear boundary
  overlap on the same winding side → `true`; (7) otherwise, `true` only if
  *every* point of `first` lies on `second`'s boundary and vice versa
  (coincident rings) — comment at `placementValidation.ts:228-230` states
  the invariant this final fallback relies on: "with strict convex rings,
  positive overlap without a strict vertex or a proper crossing can only be
  coincident boundaries." This 7-stage ordered short-circuit sequence is
  itself the primary "comparator" of this cluster and must be preserved
  stage-for-stage, not merely as an equivalent boolean formula, because
  stages 2–3 and stage 6 can each independently trigger a `GeometryFailure`
  return (propagated up as `IrregularGeometryInputError`) that a
  reformulated/reordered implementation could surface differently or not at
  all (see §11, though in practice these failure branches are unreachable
  given upstream invariants — still, "document what IS," not what is
  provably reachable).

---

## 7. Numeric semantics

- **Orientation sign inversion** (`geometryPredicates.ts:32-34`): documented
  above; the single point where `robust-predicates`' y-down convention
  becomes this app's y-up convention. A Rust port using the `robust` crate
  (or an equivalent Shewchuk-adaptive-precision `orient2d`) must apply the
  identical inversion, at the identical single call site, not scatter
  re-inversions elsewhere.
- **`orientation` provides no NaN/Infinity guard of its own** — it forwards
  raw coordinates straight to `orient2d`. Every current call site guarantees
  finite inputs upstream (via `ConvexPolygonValidation`'s finiteness check
  or `convexBounds.ts`'s `Number.isFinite` guards before any polygon reaches
  a topology test). A Rust port must preserve this "trust the caller"
  contract rather than adding a defensive check that changes behavior on
  already-invalid inputs that never reach this function in practice.
- **Signed-zero normalization** (`convexSatPenetration.ts:88-90`, dead code
  but must be documented per "TypeScript behavior IS the specification"):
  `canonicalZero(value) = Object.is(value, -0) ? 0 : value`, applied to both
  components of the SAT translation vector
  (`convexSatPenetration.ts:29-30`) before it is ever compared or returned.
  A Rust equivalent is `if value == 0.0 && value.is_sign_negative() { 0.0 }
  else { value }` — `value + 0.0` is **not** an equivalent idiom in all
  Rust/LLVM configurations claiming IEEE semantics without
  `-0.0`-preserving guarantees; prefer the explicit `is_sign_negative`
  check.
- **`Number.isFinite` finiteness gates** — used pervasively as the single
  admission test for "usable" coordinates: `convexPolygonValidation.ts:74`
  (per-vertex), `convexBounds.ts:13,22,43,57,91-94` (bounds/translation),
  `convexSatPenetration.ts:51,70,75` (axis length, projections),
  `placementValidation.ts:262,271,277` (interior-point arithmetic). Always
  `Number.isFinite`, never `!Number.isNaN(x) && Math.abs(x) !==
  Infinity` or similar — reject both `NaN` and `±Infinity` uniformly, no
  case distinguishes them. Rust's `f64::is_finite()` is the exact semantic
  match.
- **`Number.isSafeInteger` gate** (`placedCollisionSpatialIndex.ts:228-234`,
  `gridCellRange`) — applied to `minX, minY, maxX, maxY, width, height,
  cellCount` (all `Number`-typed after `Math.floor`/arithmetic), bounding
  them to `±(2^53 − 1)`. **This is a strictly narrower bound than "fits in
  an `i64`"** (`i64::MAX ≈ 9.22×10^18`; JS safe-integer bound `≈
  9.007×10^15`). A Rust port that checks "does this fit in `i64`" instead of
  replicating the exact `2^53 − 1` threshold would silently *accept* grid
  ranges TypeScript rejects, taking the indexed/bucket-scan path where
  TypeScript falls back to the `undefined`-cellRange conservative path
  (fallback-entries-only for `add`, or "select every entry" for `query` —
  see §9). This changes performance, not legality (both paths are proven
  equivalent for the final `assessPlacement` boolean by
  `placedCollisionSpatialIndex.test.ts:145-168`'s indexed-vs-direct parity
  test), but it changes cache/index construction control flow that the
  migration prompt (§13.2) explicitly requires be preserved exactly
  ("exact ordered-coordinate fingerprint requirements," "preserve each
  current sequence"). Use an explicit `const JS_MAX_SAFE_INTEGER: i64 =
  9_007_199_254_740_991` bound, not native integer-width overflow checks.
- **`Math.floor` for grid-cell coordinates** (`placedCollisionSpatialIndex.ts:220-223`,
  `gridCellRange`: `Math.floor(bounds.minX / cellSizeMm)` etc.) — **rounds
  toward negative infinity**, not toward zero. This is a genuine, high-value
  port hazard: Rust's `as i64` cast on an `f64` truncates *toward zero*, so
  `(-0.5_f64) as i64 == 0` while `Math.floor(-0.5) === -1`. Placed geometry
  can legitimately have negative translated coordinates during intermediate
  construction (e.g. before a `withBottomLeftAnchored`-style shift, or for
  pieces near the origin with negative-offset collision padding), so
  negative `bounds.minX`/`minY` are a real, not merely theoretical, input.
  **The correct Rust translation is `(bounds.min_x / cell_size_mm).floor()
  as i64`, calling `.floor()` on the `f64` before casting — never cast the
  raw quotient directly.** Getting this wrong would place entries in the
  wrong grid bucket, and because `query()`'s `selected` membership test (not
  its final `areDisjoint` re-check) gates whether an entry is even
  considered, a bucket-assignment mismatch between `add`-time and
  query-time floor semantics could produce **false negatives** (an entry
  present in `this.entries` but never surfaced by `query()` for a bounds box
  that should have matched it) — a genuine legality-correctness risk, not
  merely a performance one, if the two call sites' floor semantics ever
  diverge from each other (they cannot within this file today, since both
  `add` and `query` call the same `gridCellRange` helper — but a Rust
  reimplementation that inlines or diverges the two call sites could
  introduce exactly this bug).
- **`-0` through `Math.floor`/grid-cell math**: checked and confirmed a
  non-issue — `Math.floor(-0 / 64) === -0` is possible in principle, and
  `Number.isSafeInteger(-0) === true`, but the value only ever participates
  in numeric loop bounds (`for (let cellX = cellRange.minX; ...)`) and
  template-literal string interpolation (`` `${cellX}:${cellY}` ``), and
  JavaScript's `String(-0) === '0'` (negative zero prints without a sign).
  A Rust port representing `cellX`/`cellY` as `i64` (not `f64`) after the
  `.floor()` cast collapses `-0.0` into integer `0` automatically at the
  cast boundary, so this is a non-issue for Rust too, but is worth this
  explicit note as an audited item per the migration prompt's §8.1
  "signed zero normalization" requirement.
- **Linear-topology IEEE-754 safety envelope**
  (`convexPolygonValidation.ts:126-150`): `MIN_LINEAR_TOPOLOGY_NON_ZERO_COORDINATE
  = 2 ** -450`, `MAX_LINEAR_TOPOLOGY_COORDINATE = 2 ** 500`. A coordinate
  "supports" the fast linear simple-ring decision only if its magnitude is
  exactly `0` or falls in `[2^-450, 2^500]` for *both* `x` and `y` of *every*
  point (`supportsLinearTopologyDecision`,
  `convexPolygonValidation.ts:129-141`). Outside this envelope (or when any
  corner's turn is inconsistent, or after a completed revolution-count
  ambiguity), `validateStrictBoundary` falls back to the historical
  quadratic non-adjacent-edge sweep (`hasSelfIntersection`,
  `convexPolygonValidation.ts:229-249`) instead of the O(n) revolution-count
  decision (`completesOneRevolution`, `convexPolygonValidation.ts:204-216`).
  These exact power-of-two bounds must be reproduced bit-for-bit in Rust
  (`2.0_f64.powi(-450)` / `2.0_f64.powi(500)`, both exactly representable
  normal doubles — `2^-450` is well above the subnormal boundary `2^-1074`
  and `2^500` is well below overflow `2^1024`) — see §14 for the
  differential-fuzz test that pins this exact boundary's *dispatch*
  behavior (which of the two implementations runs), and note that the fast
  path and the fallback are independently required to agree on every input
  in-envelope, so getting the *envelope bound itself* wrong would only ever
  be caught if it caused the two decision procedures to disagree, which the
  fuzz corpus is not guaranteed to exercise at exactly `2^-450`/`2^500}`
  (see §15 open question).
- **`completesOneRevolution`** (`convexPolygonValidation.ts:204-216`) counts
  strict downward-to-non-downward transitions of edge direction
  (`edge.end.y < edge.start.y` compared to the next edge's same predicate)
  using plain `<` on `number`, no tolerance; requires the count to equal
  exactly `1`. This is an *exact* integer count derived from *exact*
  boolean comparisons on already-finite coordinates — no accumulated
  floating error risk since no arithmetic is summed, only boolean
  transitions are counted.
- **`Math.hypot`** (`convexSatPenetration.ts:50`, dead code) — edge length
  for axis normalization; `Math.hypot(dx, dy)` (not `Math.sqrt(dx*dx +
  dy*dy)`) — `Math.hypot` is specified to avoid intermediate
  overflow/underflow differently than the naive formula for extreme
  magnitudes. Rust's `f64::hypot` is the direct equivalent and should be
  used instead of `(dx*dx + dy*dy).sqrt()` to preserve identical results for
  extreme-magnitude inputs.
- **`Math.abs`, `Math.min`, `Math.max`** — used throughout for bounds
  computation (`convexBounds.ts`), segment-overlap projection
  (`placementValidation.ts:320-329`, `segmentsHavePositiveLengthOverlap`;
  and `pointIsOnSegment` at both `placementValidation.ts:416-423` and
  `convexPolygonValidation.ts:307-314`, byte-identical logic duplicated in
  two files — see §12), and SAT projection min/max tracking
  (`convexSatPenetration.ts:76-77`). All plain IEEE-754 binary operations
  with direct Rust equivalents (`f64::abs`, `f64::min`, `f64::max` — note
  Rust's `f64::min`/`max` have NaN-propagation semantics that differ subtly
  from `Math.min`/`Math.max` for NaN inputs, but every call site here
  operates on already-finite-checked values, so this divergence is not
  reachable in practice; still worth a defensive note for anyone tempted to
  simplify away an upstream finiteness check).
- **No `BigInt` usage anywhere in this cluster.** No hashing, no
  canonical-grid integer conversion happens in these eight files (that logic
  lives in `canonicalGridMath.ts`/`canonicalGridContact.ts`, a different
  cluster) — this cluster works entirely in floating-point millimeters.

---

## 8. Serialization and hashing

This cluster does **not** construct any canonical JSON that feeds a SHA-256
hash, checkpoint byte stream, or cache key. (Confirmed by grepping every
live file that both imports a hashing utility and references any of this
cluster's modules — the only match, `intrinsicQueueBeamDiscriminator.ts`, is
dead code per §1.) The one piece of self-serialization in this cluster is
purely a same-process, in-memory equality signal:

- **`continuationIdentity()`** (`placedCollisionSpatialIndex.ts:118-127`):

  ```ts
  JSON.stringify({
    cellSizeMm: this.cellSizeMm,
    entryOrdinals: this.entries.map(({ ordinal }) => ordinal),
    buckets: [...this.buckets.entries()]
      .map(([key, entries]) => [key, entries.map(({ ordinal }) => ordinal)] as const)
      .toSorted(([first], [second]) => first.localeCompare(second)),
    fallbackOrdinals: this.fallbackEntries.map(({ ordinal }) => ordinal)
  })
  ```

  Object key order in the literal (`cellSizeMm`, `entryOrdinals`, `buckets`,
  `fallbackOrdinals`) is fixed by source-code declaration order — `JSON.
  stringify` on a plain object literal preserves insertion order for
  string keys, which here is simply the four keys as written, not derived
  from any runtime `Map`/`Set`. **The only runtime-order-dependent
  component is the `buckets` array**, explicitly re-sorted by
  `localeCompare` on the cell-key string — see §5 item 5 and §12 for why
  this specific choice of comparator (rather than plain byte/codepoint
  ordering) is a hazard.

  **Only two call sites consume this string, both as a `!==` self-consistency
  check within the *same* process/language execution**:
  `intrinsicStrictDecoder.ts:1213-1218` (`validateIntrinsicStrictDirectState`,
  a checkpoint-validation helper that rebuilds an `IrregularBeamState` fresh
  from `state.placedCollisionGeometries` and compares its freshly-derived
  spatial index's identity string against the loaded state's own cached
  identity string — returning the message `'direct checkpoint spatial-index
  cache is inconsistent.'` on mismatch) and
  `intrinsicCapacitySearch.ts:1412-1413` (structurally the same pattern).
  In both cases, **the compared value on each side of `!==` is computed by
  the same runtime, in the same process, from the same underlying
  `placedCollisionGeometries` array** — `continuationIdentity()`'s string is
  never itself persisted into a checkpoint file, never crosses a
  process/language boundary in the current architecture, and this cluster's
  grep found no other consumer. Because of this, exact byte-for-byte
  `localeCompare`-order reproduction in Rust is **not required for
  behavioral correctness of these two checks** — any deterministic,
  injective (same-index-content ⇒ same-string; different-content ⇒
  different-string) canonical encoding implemented consistently on both
  sides of a Rust `!=` would preserve the same true/false outcome. It
  **is** required if the orchestrator determines (outside this cluster's
  file scope) that a byte-identical `continuationIdentity()` string is
  needed for some other purpose not found by this grep — see §15.
- **Similarly-shaped identity strings exist one layer up** in
  `irregularBeamState.ts` (`continuationMetadataIdentity`,
  `canonicalEntryContinuationIdentity`,
  `contactSignatureContinuationIdentity`, lines 148-170), all
  `JSON.stringify` of arrays/maps, one of which (`contactSignatureContinuationIdentity`,
  line 162-169) uses the identical `localeCompare`-based sort pattern on a
  *different* map's keys. These are a different cluster's primary subject
  (`irregularBeamState.ts` is not one of this cluster's eight files) but are
  flagged here because they share the exact same `localeCompare` hazard
  pattern — worth a single shared Rust utility function that the
  `irregularBeamState`/beam-search cluster's characterization should also
  reference.
- **`cellKey(cellX, cellY)`** (`placedCollisionSpatialIndex.ts:244-246`):
  `` `${cellX}:${cellY}` `` — plain JS `Number`-to-`String` decimal
  formatting of two already-integer-valued (via `Math.floor`) doubles. No
  exponential notation risk at realistic grid-cell magnitudes (JS switches a
  number's default `toString()` to exponential form only outside
  `1e-7…1e21` in magnitude, and legitimate cell indices are minuscule by
  comparison). Rust's `format!("{cellX}:{cellY}")` on `i64` values is a
  direct, unhazarded equivalent (unlike the `f64` `Display` hazards
  elsewhere in this codebase's canonical-grid code, which is out of this
  cluster's scope).

---

## 9. Caches touched and the exact historical access sequence

This cluster does not touch the shared `GeometryCacheStore`
(NFP/IFP/transform-collision cache, a different cluster's subject). Its own
"cache" is the `PlacedCollisionSpatialIndex` broad-phase structure. The
exact, must-preserve access sequence inside `assessPlacement`
(`placementValidation.ts:70-144`) is:

1. Translate and validate the **moving** polygon first
   (`translateAndValidatePolygon(input.moving.polygon, input.candidate.point,
   'moving')`, line 74-78). Any failure here returns immediately — the
   spatial index is never even consulted if the moving polygon itself is
   invalid.
2. Read `input.placedCollisionIndex` (may be `undefined`) and test
   `spatialIndex.matches(input.placed)` (line 85-89). **This exact
   `matches()` check is performed twice on the hot path today**: once one
   level up, inside `nfpIfpService.ts:308-311`'s `generatePlacementCandidates`,
   before the per-candidate-point loop begins (hoisting the index-or-
   undefined decision *once* per NFP/candidate-generation call), and then
   **again**, redundantly, inside `assessPlacement` itself
   (`placementValidation.ts:87`), once per candidate point, because
   `assessPlacement` has no way to know its caller already validated the
   match. `input.placed` and the index are both loop-invariant across
   `nfpIfpService.ts`'s per-point loop, so this repeated `O(placed.length)`
   `matches()` scan is pure duplicated work with no behavioral effect — a
   legitimate, semantics-preserving Stage-2/3 Rust optimization (hoist the
   match decision once per `generatePlacementCandidates`-equivalent call, not
   once per candidate point), explicitly permitted by the migration prompt's
   "only accepted... improvement is reduced execution time" rule, *provided*
   the two call sites are proven to always observe the same `input.placed`
   reference across the loop (true today by construction — the loop never
   reassigns `input.placed`).
3. **If matched:** call `spatialIndex.query(movingPolygon.bounds)`
   (line 88) — broad-phase bucket lookup, itself internally: (a) seed
   `selected` with all `fallbackEntries` (entries whose own bounds are
   invalid or whose cell fan-out exceeded `MAX_GRID_CELLS_PER_ENTRY`); (b)
   compute the query's own `cellRange` from `movingPolygon.bounds`, bounded
   by `MAX_GRID_CELLS_PER_QUERY = 4096`
   (`placedCollisionSpatialIndex.ts:12,131-133`); (c) if the query bounds
   are themselves too large for a bounded cell range, fall back to adding
   *every* entry to `selected` (line 135-136, "select all" conservative
   degrade); (d) otherwise, for each cell in the bounded range, add every
   entry in that cell's bucket to `selected` (line 138-144); (e) build the
   final result by filtering `this.entries` (ordinal order, per §5) —
   entries with `validationMessage !== undefined || indexedBounds ===
   undefined` are included whenever merely `selected.has(entry)` is true
   (no further bounds check — **an invalid placed entry, once it becomes
   part of `fallbackEntries` at `add()` time, is unconditionally returned by
   every subsequent `query()` call regardless of the query bounds**); valid
   entries additionally require `!areDisjoint(entry.indexedBounds, bounds)`
   (the exact precise re-check that makes the broad-phase bucket lookup safe
   even when bucket assignment is itself only approximate/conservative).
   Then iterate the returned entries in that exact (ordinal) order
   (`placementValidation.ts:91-103`): any `validationMessage` present
   → immediate `IrregularGeometryInputError` failure (poisons the *entire*
   `assessPlacement` call, not just candidates near that invalid piece —
   see §11); any `translated === undefined` with no message (should be
   structurally impossible per §3's three-way coupling, but checked
   defensively) → a different, hardcoded failure message; otherwise push
   `entry.translated` onto `placedPolygons`.
4. **If not matched (index absent or stale):** iterate `input.placed` in
   caller-array order (line 105-119), translating and validating each piece
   fresh via `translateAndValidatePolygon` (line 106-113) — no reuse of any
   cached translated polygon, full recomputation, but functionally
   equivalent output per the parity test cited in §3/§5.
5. **Only after** the placed-polygon list is fully assembled (from either
   branch) does the sheet-bounds check run (line 122-128, only if
   `enforceSheetBounds && 'sheet' in input`), followed by the per-placed-
   polygon overlap loop (line 130-141, the 7-stage sequence from §6), in
   `placedPolygons` order (ordinal order for the indexed branch, caller
   order for the brute-force branch), returning `{ legal: false, message:
   '...positive-area overlap...' }` on the first positive-area overlap
   found.

**Nothing in this cluster ever writes an invalid result into the spatial
index as if it were valid** — `makeEntry` (`placedCollisionSpatialIndex.ts:159-195`)
always records the true validation outcome (message or translated polygon),
and `query()`/`assessPlacement` always re-surface a stored
`validationMessage` as a hard failure rather than silently treating it as
"no overlap." This satisfies the migration prompt's §13.1 "invalid or stale
values are never published as valid hits" principle by construction, even
though this structure predates that prompt.

**Cache lifetime**: job/branch-local. A `PlacedCollisionSpatialIndex`
instance's lifetime is tied to the beam-search state node (a different
cluster's ownership) that holds it; this cluster's files impose no
process-level or cross-job caching, memory cap, or eviction policy of their
own — every instance is plain, GC-managed, immutable data with no explicit
cleanup step required or present.

---

## 10. Cancellation / deadline / budget / evaluation-cap observation points

**None exist inside these eight files.** Every function in this cluster is
synchronous and non-suspending — none returns an `Effect` that can yield to
a fiber scheduler mid-computation, none polls a control/cancellation object,
none reads a deadline or budget. `placementValidation.ts`'s own docstring
states this as an intentional design property (`placementValidation.ts:61-69`):
"The geometry here never suspends... wrapping it in `Effect` cost one effect
construction and one fiber step per point for no benefit." Even the
`Effect`-typed wrappers (`PlacementValidation.check`/`checkSheetless`/`validate`)
are thin synchronous-to-Effect lifts (`assess`, `placementValidation.ts:147-155`)
with no internal suspension point.

This has a direct, load-bearing implication for the Rust port: **a Rust
translation of any function in this cluster may be an ordinary synchronous
call with no cancellation-check injection points of its own**, and the
migration prompt's cooperative-checkpoint cadence (§15 of the prompt: "Map
and preserve the current observation points... moving a check earlier can
change which work... occurs before termination") is entirely the
responsibility of the *calling* cluster, not this one. The concrete
observed calling patterns (context only, not owned by this cluster):

- `nfpIfpService.ts:496` — `if (pointIndex % 32 === 0) yield* nfpCheckpoint(input.control,
  'candidate-points')`, checked once per 32 candidate points, **before**
  calling `assessPlacement` for that point (the checkpoint is outside/around
  the `assessPlacement` call, never inside it).
  `nfpIfpService.ts:280,307,315` — three more `nfpCheckpoint` calls at
  different phase boundaries (`'ifp'`, `'ifp'` again, `'placed-nfp'`) before
  this cluster's functions are ever reached.
- `intrinsicPeriodicCells.ts:473-475` — a wall-clock deadline check
  (`performance.now() - input.startedAt >= input.options.maximumRuntimeMs`)
  immediately before each `PlacementValidation.checkSheetless` call, plus a
  `control?.checkpoint('candidate-points')` cooperative yield just before
  that.
- `windowedBeam.ts:1305` — a `controlCheckpoint` call **after** the
  `PlacementValidation.check` call that produces
  `reconstructionIncumbentCandidate`, not before.

A Rust port must preserve the *positions* of these checks relative to calls
into this cluster's functions exactly as found in each calling cluster's own
characterization — this cluster's own contribution to that requirement is
simply: **do not introduce any new suspension, cancellation check, or
early-return-for-budget inside these eight functions**, since none exists
today and none is safe to add without violating the "moving a check changes
what occurs before termination" warning.

---

## 11. Error paths

**Only one error type originates in this cluster**: `IrregularGeometryInputError`
(defined in `services.ts:42-45`, a `Data.TaggedError` with fields `operation:
string` and `message: string`). It is constructed in exactly one place in
this cluster, `placementValidation.ts:157-162` (`invalidGeometryFailure`),
always with `operation: 'validatePlacement'` — this operation string is a
**fixed literal**, not derived from which internal check actually failed
(same for both the `validate` Effect path, `failInvalidGeometry`'s
`operation` parameter at `placementValidation.ts:425-430`, which the sole
call site at line 56 also hardcodes to `'validatePlacement'`). Every other
distinguishing information is carried only in `message`, not `operation`.
Per the migration prompt's §16 error-mapping table, `IrregularGeometryInputError`
maps externally to `AppErrorCode.irregular_geometry_invalid` with required
context field `operation` — since `operation` is always the same string
here, a Rust port's external error surface for this cluster's failures
carries no operation-level disambiguation beyond "placement validation
failed," consistent with current behavior.

**The other six files never throw, never fail an `Effect`, and never
construct a tagged error class.** `convexPolygonValidation.ts`,
`convexBounds.ts`, `geometryPredicates.ts`, `convexSatPenetration.ts`,
`convexHull.ts`/`core/convexHullCore.ts` all communicate failure purely as
data: a `{ message: string }` sentinel object (for the validation-shaped
functions) or `undefined` (for the bounds/translation/SAT functions). It is
`placementValidation.ts` and `placedCollisionSpatialIndex.ts` that are the
two files responsible for converting those sentinels into either a
propagated `IrregularGeometryInputError` (`placementValidation.ts`) or a
stored `validationMessage` string on a `PlacedCollisionSpatialEntry`
(`placedCollisionSpatialIndex.ts:159-195` — note: this file never
constructs an `IrregularGeometryInputError` itself; it stores the raw
`message` string, and it is `placementValidation.ts:92-94` that later
promotes a stored `validationMessage` into a thrown
`IrregularGeometryInputError` when that entry surfaces from `query()`).

**Exact message-string catalogue** (contractual text; several are pinned
byte-for-byte by test `.toBe(...)`/`.toEqual(...)` assertions cited
throughout this document):

From `placementValidation.ts`:
- `` `${label} translation must produce finite polygon coordinates.` ``
  where `label` is `'moving'` or `'placed'` (line 243, via
  `translateAndValidatePolygon`)
- `'placed translation must produce finite polygon coordinates.'`
  (hardcoded literal, line 98, in the indexed-entry branch — byte-identical
  to the `label='placed'` case above, but written as a separate literal, not
  a shared constant)
- `'moving polygon must remain inside the sheet.'` (line 127)
- `'moving polygon has positive-area overlap with placed collision
  geometry.'` (line 138)
- `'polygon interior-point arithmetic must produce finite coordinates.'`
  (lines 263, 272, 278 — three occurrences, one function,
  `strictConvexInteriorPoint`)
- `'polygon interior side arithmetic must produce a finite classification.'`
  (line 305, `boundariesHavePositiveCollinearOverlap`)

From `convexPolygonValidation.ts`:
- `'polygon must contain at least three vertices.'` (line 64)
- `'polygon points must form a closed boundary.'` (lines 71, 86, 169 — three
  occurrences, defensive `undefined`-element guards)
- `'polygon coordinates must be finite.'` (line 75)
- `'polygon must not repeat adjacent vertices.'` (line 90)
- `'polygon must form a simple ring without self-intersections.'` (line 106)
- `'polygon must not contain collinear vertices.'` (line 175)
- `'polygon must be strictly convex with one consistent winding.'` (line 184)
- `'polygon must have a non-zero area.'` (line 112)

From `placedCollisionSpatialIndex.ts`:
- `'placed translation must produce finite polygon coordinates.'` (line
  171, `makeEntry` — a **third**, independent occurrence of this exact
  string, this time in a different file)

`convexBounds.ts` and `geometryPredicates.ts` and `convexSatPenetration.ts`
produce no message strings at all (pure `undefined`-on-failure or
non-failing functions).

**Practically-unreachable-but-written failure branches** (document per
"TypeScript behavior IS the specification, including... oddities," not
omit): `boundariesHaveProperCrossing`
(`placementValidation.ts:332-375`) declares a return type including
`GeometryFailure` but its body never actually constructs one — always
returns `{ value: boolean }`. `boundariesHavePositiveCollinearOverlap`
(`placementValidation.ts:285-318`) *can* return the "interior side
arithmetic" failure message if `second.points.find(...)` returns
`undefined`, i.e. if every vertex of `second` is exactly collinear with one
edge of `first` — but `second` is already guaranteed strictly convex (no
three collinear vertices) by `ConvexPolygonValidation.validateStrictBoundary`
before it can reach this function, so this branch requires *every* vertex of
a strictly-convex polygon to be collinear with an external line, which is
impossible for `≥3` vertices under strict convexity. `strictConvexInteriorPoint`'s
three finiteness checks (`placementValidation.ts:262,271,277`) are similarly
defensive: `weight = 1/points.length` for an already-validated (≥3 vertices,
finite coordinates) polygon cannot realistically produce non-finite weighted
sums except at coordinate magnitudes that `ConvexPolygonValidation` does not
itself bound (unlike the linear-topology envelope, `validateStrictBoundary`'s
core finiteness check only requires `Number.isFinite`, not
`|coordinate| ≤ 2^500`) — so this branch is reachable in principle for
extreme-magnitude valid polygons, unlike the fully-unreachable branches
above. A Rust port must preserve all of these as real, reachable-in-principle
code paths, not delete them as "dead code," except for the two genuinely
provably-unreachable ones (`boundariesHaveProperCrossing`'s unused
`GeometryFailure` arm, and `boundariesHavePositiveCollinearOverlap`'s
`secondInteriorPoint === undefined` arm) — and even those should be kept as
written (the migration prompt does not authorize removing "unreachable"
code paths merely because a proof of unreachability exists; changing a
function's return-type shape is itself an observable API change if anything
downstream pattern-matches on it).

---

## 12. JS-specific semantics hazards for a Rust port

1. **`localeCompare` is not byte/codepoint ordering, and its default-locale
   behavior is not guaranteed stable across environments** (highest-severity
   finding in this cluster). `placedCollisionSpatialIndex.ts:124`
   (`continuationIdentity`) sorts cell-key strings (`"${cellX}:${cellY}"`,
   e.g. `"-3:5"`) with `first.localeCompare(second)` and **no locale
   argument**. Empirically, in this sandbox's Node build (`v24.18.0`, `en-US`
   resolved default locale), this produces a **different order** than plain
   byte comparison for negative-number-containing keys:
   ```
   locale: ['-1:-1','-10:5','-3:5','-9:9','0:0','1:1','10:0','10:5','2:5','9:9']
   byte:   ['-10:5','-1:-1','-3:5','-9:9','0:0','10:0','10:5','1:1','2:5','9:9']
   ```
   (verified with `node -e '...'` in this repo's environment; see transcript
   in this document's research trail). The JS spec does not require
   zero-argument `localeCompare` to be locale-independent or stable across
   Node/ICU builds — it explicitly resolves "the current default locale."
   This sandbox showed the same order across `LANG=en_US.UTF-8`, `LANG=de_DE.UTF-8`,
   and `LANG=C`, but `Intl.DateTimeFormat().resolvedOptions().locale` stayed
   `en-US` in all three cases too, suggesting this container does not
   honor `LANG` for `Intl` locale resolution at all — which is itself a
   fact about *this* sandbox, not a portable guarantee about every Node
   runtime/Electron packaging target this code ships on. As characterized in
   §8, the only two current production consumers of this exact string
   compare it to another same-process, same-language invocation, so exact
   `localeCompare` replication is not required for *those* two checks'
   correctness — but a Rust implementation must not assume it can safely
   substitute plain byte ordering and later regret it if a new consumer
   (or a cross-language checkpoint scenario per the migration prompt's §11)
   ever needs byte-identical output. Recommend: (a) confirm with the
   caches/checkpoint cluster whether this string, or the sibling
   `irregularBeamState.ts` identity strings using the same pattern, ever
   crosses a checkpoint/persistence/cross-process boundary; (b) if not,
   implement the Rust equivalent with a plain, fully-specified,
   locale-independent ordering (e.g. `(i64, i64)` tuple ordering by parsed
   `(cellX, cellY)`, which is both simpler and strictly total) rather than
   attempting to replicate ICU collation.
2. **Reference-identity equality used as a cache-validity signal.**
   `PlacedCollisionSpatialIndex.matches` (`placedCollisionSpatialIndex.ts:106-116`)
   compares `entry.placed !== placedPiece` — JavaScript's `!==` on two
   object references, i.e. pointer/identity equality, not structural
   equality. `IrregularPlacedPiece` has no custom `equals`; two
   independently-constructed-but-structurally-identical instances compare
   unequal. This is safe for *correctness* today (a `false` result only
   costs a full index rebuild via `makePlacedCollisionSpatialIndex`,
   producing an equivalent result — proven by the parity test cited
   throughout this document) but is a genuine *performance* semantics to
   replicate deliberately: a Rust port must use an equivalent cheap identity
   check (e.g. `Arc::ptr_eq` on an `Arc<IrregularPlacedPiece>`, or an
   explicit monotonic version/generation counter attached at construction)
   rather than a deep-equality comparison, both to match the current
   reuse/rebuild trigger frequency (deep-equality would reuse *more* often
   than today's TypeScript, changing performance characteristics in a way
   the migration prompt's Stage 3/4 cache-architecture review should
   evaluate deliberately, not inherit by accident) and because a `Vec`/`Arc`
   of owned, non-reference-counted structs has no native notion of "the same
   instance" to check at all — this must be an explicit design decision in
   the Rust port's state representation (e.g. wrap placed pieces in `Arc` at
   the exact points where `IrregularPlacedPiece` objects are constructed
   once and then threaded through unchanged, matching where TypeScript's
   reference identity happens to be preserved today).
3. **`Math.floor` vs. Rust's truncating `as` cast for negative numbers** —
   detailed fully in §7. Repeated here because it is squarely a
   "JS-arithmetic-semantics vs. Rust-cast-semantics" hazard in the sense the
   migration prompt's §12 asks to catalogue, and it is the single highest
   correctness-risk (not merely performance-risk) numeric item in this
   cluster.
4. **`Number.isSafeInteger`'s exact `2^53 − 1` threshold** — detailed fully
   in §7; a naive "does this fit in a 64-bit integer" Rust check is *not*
   equivalent and is measurably wider than JS's safe-integer bound.
5. **Stable-sort reliance is present but inconsequential here.**
   `convexHullCore.ts:6-9`'s `Array.prototype.sort` relies on ES2019+
   guaranteed stability, but because `InternalPoint` has no field beyond
   `x`/`y`, no equal-comparator pair is ever distinguishable after sorting —
   Rust's `slice::sort_by` (stable) is the correct choice for defensive
   parity with the general "JavaScript sorting is stable" rule from the
   migration prompt's §9, even though this specific call site would not
   observably differ if `sort_unstable_by` were used instead. Do not use
   `sort_unstable_by` here as a matter of policy, since the *general* rule
   (not this specific instance) is what the migration prompt asks to be
   preserved uniformly.
6. **`Map`/`Set` iteration order is deliberately *not* an output-ordering
   source in `query()`**, as detailed in §5 item 4 — flagged here as a
   hazard-in-the-other-direction: a Rust port using `std::collections::
   HashMap`/`HashSet` (unordered, randomized) for the `buckets`/`selected`
   equivalents is **safe** for `query()`'s output order specifically,
   *because* `query()` never iterates them for output — it only tests
   membership and then filters the ordinal-ordered `entries` vector. This is
   worth stating explicitly so a Rust implementer does not over-correct by
   forcing a `BTreeMap`/`IndexMap` here "just in case" where the source does
   not need one. The one place order *does* matter
   (`continuationIdentity()`) already re-sorts explicitly (see hazard 1
   above) and must keep doing so (with a locale-independent comparator).
7. **Duplicated, byte-identical literal logic across files, not shared.**
   `pointIsOnSegment` exists twice, verbatim, in `placementValidation.ts:416-423`
   and `convexPolygonValidation.ts:307-314` (same four-comparison inclusive-bounds
   test). The string `'placed translation must produce finite polygon
   coordinates.'` exists three times (see §11). `convexBounds.ts:75-82`'s
   `areDisjoint` and `placedCollisionSpatialIndex.ts:254-261`'s `areDisjoint`
   are byte-identical independent copies (`placedCollisionSpatialIndex.ts`
   does **not** import `areDisjoint` from `convexBounds.ts`, despite
   importing `translatePolygonWithBounds` from the same file). None of this
   is a bug — every copy is behaviorally identical to every other — but a
   Rust port that "cleans this up" into one shared function changes nothing
   observable and is explicitly permitted (deduplication is not a semantic
   change), while a Rust port that accidentally lets one copy drift from
   another during translation would be a real, silent parity bug; recommend
   deliberately sharing one Rust implementation for each duplicated pair
   specifically to eliminate this drift risk, which is safe under the
   migration prompt's rules because it does not change any observable
   behavior.
8. **UTF-16/string-comparison hazards beyond `localeCompare`**: none found.
   No other string comparison in this cluster (`typeof`, `'message' in x`,
   `'sheet' in input`, exact string equality in error-message construction)
   is locale- or encoding-sensitive; all message strings are ASCII, and all
   structural discriminant checks (`'message' in x`, `'failure' in x`) are
   TypeScript's structural `in`-operator idiom for tagged unions, not string
   *content* comparisons — a Rust `enum` match is the natural, unhazarded
   translation.

---

## 13. Parallelism assessment

**Pure and independent (candidates, with caveats noted per item):**

- `GeometryPredicates.orientation` — a pure `O(1)` function of three points,
  no shared state, trivially safe to call from any number of threads
  concurrently. Not valuable to parallelize *by itself* (the per-call cost
  is a handful of floating-point operations); only valuable as part of a
  larger batch reduction (see below).
- `ConvexPolygonValidation.validateStrictBoundary` — pure, `O(n)` (fast
  path) or `O(n²)` (fallback sweep) per polygon, with **no shared state
  across different polygons**. Independent validation of *different*
  polygons (e.g. validating every placed piece's translated polygon
  up-front) is a safe, stable-indexed Rayon candidate per the migration
  prompt's §14.1 pattern ("independent collision-geometry preparation by
  stable piece index"). However, per the linear-ring-topology corpus
  finding cited in §1 ("97% at eight vertices or fewer and none above
  sixteen"), individual polygons are tiny — parallelizing *within* one
  polygon's validation (e.g. across its edges) is not valuable; the
  parallelism opportunity, if any, is *across* polygons in a batch, not
  within one.
- `convexBounds.ts`'s `boundsForPoints`/`translatePolygonWithBounds`/`areDisjoint`
  — pure, `O(n)`/`O(1)`, same batch-across-independent-polygons reasoning as
  above.
- `core/convexHullCore.ts`'s `computeConvexHull` — pure per call, but (a)
  its own internal sort/scan is sequential-with-backtracking (not a
  parallel-friendly access pattern for the tiny `N` typical here — hull
  inputs are Minkowski-sum point sets, `|fixed| × |moving|`, still small
  given the corpus finding above), and (b) **it is exercised extremely
  frequently** (once per pairwise NFP construction in the live default
  `'vertex-pair-hull'` algorithm, per §2) — so the parallelism opportunity
  here is the migration prompt's §14.1 "independent pairwise relative NFP
  computations after key deduplication," i.e. computing *many different*
  NFP boundaries (and therefore many different `computeConvexHull` calls)
  concurrently across independent piece pairs, not parallelizing the
  internals of one hull computation. This is explicitly named in the
  migration prompt's §14.1 as a good candidate to investigate, conditional
  on the NFP-cache single-flight/deduplication design (Stage 3) being in
  place first — this cluster's file (`convexHullCore.ts`) is a pure leaf
  with no caching of its own, so it imposes no additional constraint beyond
  "call it with fully-known, already-deduplicated inputs and reduce results
  by stable pair-index," which is the calling cluster's (`nfpIfpService.ts`
  / `nfpBoundaryCore.ts`) responsibility to implement.
- `PlacedCollisionSpatialIndex.query(bounds)` on an **already-constructed,
  immutable** index — read-only, no mutation of `this`, safe for concurrent
  multi-threaded reads of one shared instance. This is the exact case the
  migration prompt's §14.1 names directly: "read-only spatial-index queries
  for an immutable state." A Rust port sharing one `Arc<SpatialIndex>`
  across Rayon worker threads for concurrent `query()` calls (e.g.
  evaluating many independent candidate points against the *same* placed-set
  snapshot) is safe and requires no locking beyond `Arc`'s reference
  counting, **provided** the index is never mutated (`add`-ed to) while any
  concurrent `query()` might be in flight against the same logical
  "snapshot" — which the current design already guarantees structurally,
  since `add()` never mutates `self`, only ever returns a new instance.
- `PlacedCollisionSpatialIndex.add(placed)` from a **shared parent** — each
  call is a pure function of `(parent, one new piece)` and produces an
  independent new index; **multiple sibling branches of a beam search could
  safely call `.add()` on the same parent from different threads
  concurrently** with no data race, since none of them mutates the parent.
  This is a genuine Stage 4 opportunity, but is explicitly **conditional on
  Stage 3 cache-architecture work first** (per the migration prompt's §13
  framing "do not enable broad Rayon parallelism until the cache
  architecture is designed"): today's `add()` is `O(n)`-copy-heavy (§4), so
  naively parallelizing many `O(n)`-copy calls does not reduce total work,
  only spreads the copying across threads — the higher-value move is first
  adopting a cheaper persistent structure (e.g. a `Rc`/`Arc`-chained
  append-only structure, or an actual immutable spatial tree with
  `O(log n)`-ish incremental update) so that `add()` becomes cheap enough
  that parallelizing *many* sibling `add()` calls is worth the thread
  coordination overhead at all.
- `assessPlacement`'s per-placed-polygon overlap check (§6's 7-stage
  sequence, and within it, e.g. `boundariesHaveProperCrossing`'s nested
  edge×edge double loop) — the *outer* per-`placedPolygon` loop
  (`placementValidation.ts:130-141`) and the *inner* per-edge-pair loops
  within `polygonsHavePositiveAreaOverlap`'s helper functions are, in the
  common case, "does any pair satisfy predicate P" (`OR`-reductions with no
  side effects beyond the boolean and, rarely, a `GeometryFailure`). `OR`
  over a fixed, already-known set of pairs is associative and
  order-independent *for the boolean result*, making this a theoretically
  safe Rayon "any" reduction — **but** the current sequential
  implementation's early-`return true`-on-first-match behavior additionally
  determines, on the rare `GeometryFailure` path, *which* failure surfaces
  first when the sequential scan would have hit `true` before ever reaching
  a point that could fail. Given §11's finding that the reachable
  `GeometryFailure` paths in this cluster are either provably unreachable or
  reachable only for pathological extreme-magnitude inputs that upstream
  validation rarely admits, a parallel "any" reduction that (a) still
  produces the identical boolean, and (b) — only in the vanishingly rare
  case a failure *does* occur — selects the failure using a
  stable-index/first-in-original-order tie-break rather than "whichever
  thread got there first," would be a faithful, if low-value-given-current
  polygon sizes, Rayon candidate. Given the tiny per-polygon vertex counts
  from the cited corpus (≤8 typical), the realistic per-call work here is
  already too small to benefit from thread dispatch overhead — flag this as
  "theoretically safe, practically not worth parallelizing at today's
  problem sizes," matching the migration prompt's instruction not to
  parallelize by intuition.

**Must stay serial (or logically serial, per the migration prompt's §14.2 /
§14.3 framing):**

- The **overall 7-stage short-circuit sequence** inside
  `polygonsHavePositiveAreaOverlap` (§6) must remain logically ordered:
  later, more expensive/exotic stages (interior-point construction,
  collinear-overlap scan) must not run, or have their side-channel
  `GeometryFailure` observed, ahead of an earlier stage's `{ value: true }`
  short-circuit, to preserve today's fastest-exit-wins performance
  characteristic and, more importantly, to preserve which
  `GeometryFailure` (if any, in the rare reachable case) is reported first
  when a Rust port fuses stages for performance.
- The **indexed-vs-brute-force branch choice** inside `assessPlacement`
  (driven by `matches()`) must remain a single up-front decision per call,
  not something re-evaluated or raced mid-computation.
- The **spatial-index `add()`/`query()`/`matches()` sequence relative to
  cancellation/deadline checks in the calling clusters** (§10) must not be
  reordered relative to those checks — this cluster's functions themselves
  have no checks to reorder, but a Rust port must not *introduce* new
  suspension points inside a batch that a calling cluster currently treats
  as one atomic, non-preemptible unit of work between two checkpoints.
- **Nothing in this cluster participates in archive admission, survivor
  selection, checkpoint publication, or trace emission** (those all belong
  to other clusters) — so none of the migration prompt's §14.2 "high-risk
  boundaries" apply *directly* to these eight files' own code, but this
  cluster's functions are called *from inside* several of those high-risk
  loops (candidate generation, beam-state placement) in other clusters, so
  a Rust port must ensure any internal parallelism added *here* composes
  correctly with (i.e. completes deterministically before) whatever
  serial/ordered reduction the calling cluster performs immediately
  afterward.

---

## 14. Tests and gates covering this cluster

Direct unit tests (one file per primary module, all read in full for this
document):

| Test file | Covers |
| --- | --- |
| `tests/unit/placementValidation.test.ts` (304 lines) | `PlacementValidation.check`/`validate`, `assessPlacement`'s pure-failure-provenance path, edge/vertex touching legality, positive-overlap rejection (including a diamond-inscribed-in-square case and a rotated-boundary-contact case), sheet-bounds rejection, and the `GeometryKernel.Live` wiring assertion (§2). |
| `tests/unit/placedCollisionSpatialIndex.test.ts` (169 lines) | Broad-phase bucket filtering with boundary-touching survival, parent/child persistence under `add` (structural-sharing proof), conservative fallback-set retention for invalid placed geometry, and a direct differential parity check between the indexed and brute-force `assessPlacement` paths across contact/overlap/disjoint candidate points. |
| `tests/unit/geometryPredicates.test.ts` (28 lines) | The DXF y-up sign convention for all three turn outcomes, plus one case pinning that the *robust* predicate correctly resolves a turn whose naive-double-subtraction determinant rounds to exactly zero (`Number.EPSILON`-scale points) — a direct exactness proof for the `robust-predicates` dependency. |
| `tests/unit/convexSatPenetration.test.ts` (38 lines, dead-code coverage) | Separation/exact-touch → `undefined`, deterministic minimum translation for a known axis-aligned overlap, and a diamond-vs-square case asserting depth/translation-magnitude consistency (not an exact expected value). |
| `tests/unit/convexPolygonValidation.test.ts` (51 lines) | Baseline accept/reject table: both windings accepted, pentagram/bow-tie/non-adjacent-touch self-intersections rejected, simple concave ring rejected. |
| `tests/unit/convexPolygonValidationTopology.test.ts` (396 lines) | The critical differential-fuzz gate for the guarded linear-topology fast path (§7): re-implements the pre-optimization quadratic oracle in the test file itself and asserts **exact object equality including message text** against `ConvexPolygonValidation.validateStrictBoundary` across `>6500` generated cases (regular/perturbed convex rings, wide star families across many vertex/step/phase/radius/winding combinations, pinch/touch cases, `6000` random trials), with explicit minimum-count assertions per outcome category (`accepted > 500`, `simpleRingRejections > 100`, `turnRejections > 500`, `linearOnlyRejections > 1000` — the last being cases only the linear revolution-count decision, not a simple oracle-agreement check, can resolve). Also separately pins the "crossing reported ahead of turn failure" precedence rule (§6) and the extreme-coordinate envelope fallback (§7) with two more object-identity assertions. **This is the single most rigorous test in this cluster and the primary parity gate a Rust port must reproduce or exceed** for `convexPolygonValidation.ts`. |
| `tests/unit/convexBounds.test.ts` (47 lines) | Strict-vs-touching-vs-overlapping-vs-disjoint bounds separation, same-pass translate+rebound correctness, non-finite rejection for both translated and source coordinates. |

Indirect coverage (relevant part read; primary subject belongs to a
different cluster):

- `tests/unit/nfpIfpService.test.ts` — exercises `assessPlacement` through
  `generatePlacementCandidates`'s live call path, and exercises `matches()`
  reuse behavior indirectly via `placedCollisionIndex` construction/passing.
- `tests/unit/geometryBackendParity.test.ts:289-331` — the differential
  oracle between `'linear-edge-merge'` and `'vertex-pair-hull'` NFP
  construction, which is the parity gate protecting `computeConvexHull`'s
  live-default correctness against the alternate algorithm (§2).
- `tests/unit/irregularGeometryKernel.test.ts` — exercises
  `GeometryKernel.Live`'s `convexHull` operation (hence `ConvexHull.compute`
  / `computeConvexHull`) as part of full collision-geometry preparation, not
  in isolation.
- `tests/unit/intrinsicCapacityMode.test.ts` — references
  `placedCollisionSpatialIndex.js`.

No test file imports `convexHull.js` or `core/convexHullCore.js` by name —
coverage is entirely indirect (via `irregularGeometryKernel.test.ts`,
`nfpIfpService.test.ts`, `geometryBackendParity.test.ts`, and several more
NFP/IFP-adjacent test files identified by a broader `grep -rl "convexHull"
tests/`). This is a genuine coverage gap for a Rust port's own
unit-test suite: recommend adding direct `compute_convex_hull` unit tests
(degenerate ≤2-point input, collinear-input collapse to two points,
known-shape hull vertex/winding checks) rather than relying solely on the
indirect NFP-level differential gate.

Instrumentation (not a correctness gate, but a named cost-center used by
Stage 0's evidence-gathering per the migration prompt's §6): `scripts/analyze-cpu-profile.ts:59-70`
defines the `spatial index` and `placement validation / convex predicates`
CPU-profile categories consumed by `pnpm profile:mixed61`, cited in §1.

No `scripts/` file other than `analyze-cpu-profile.ts` references any file
in this cluster.

**Coverage gaps worth flagging for the orchestrator (see also §15):**
- No test directly exercises `MAX_GRID_CELLS_PER_ENTRY`/`MAX_GRID_CELLS_PER_QUERY`
  (`= 4096` each, `placedCollisionSpatialIndex.ts:11-12`) — i.e. no test
  constructs an entry or query bounds whose grid-cell fan-out exceeds 4096
  to confirm the conservative-fallback path (§9) is actually reached and
  behaves as documented. Recommend a dedicated test before/alongside the
  Rust port to lock this boundary byte-for-byte.
- No test exercises `Number.isSafeInteger`'s exact rejection boundary in
  `gridCellRange` (§7) — e.g. bounds whose cell-count arithmetic lands just
  above `2^53 − 1`.

---

## 15. Open questions and ambiguities

1. **Should the Rust port include `convexSatPenetration.ts` (and the
   `overlapRelaxation*`/`targetedExactLns`/`intrinsicTwoPieceInterfaceReconstruction`/`intrinsicDetachedPieceReinsertion`
   island it exclusively serves) at all?** §1 establishes with grep-proof
   that this entire island has zero non-test production callers reachable
   from `computeIrregularNesting.ts`. It is not named anywhere in the
   migration prompt's §4.1 "Included" scope list or its §5 authoritative
   file map. Recommend: **exclude from Stage 2's "complete single-thread
   Rust parity" scope**, since porting unreachable code cannot be
   differentially validated against any production Compact/Compact Short
   Side job and would not affect "exact differential comparison against
   TypeScript" for any real request. This document characterizes it fully
   (per the task's "document what IS" instruction) so the decision is
   informed, not because inclusion is assumed. **Needs an explicit
   orchestrator ruling** before Stage 1/2 scoping is finalized, since the
   migration prompt's own text says "The completed architecture must not be
   a small collection of Rust hot kernels" and separately requires
   preserving "the existing irregular TypeScript implementation as a
   maintained reference backend" — neither statement resolves whether an
   *unreachable* TypeScript module needs a Rust counterpart.
2. **Does `continuationIdentity()` (or its `irregularBeamState.ts` sibling,
   `contactSignatureContinuationIdentity()`) ever cross a checkpoint,
   persistence, or cross-language boundary?** This cluster's own grep found
   only same-process, same-language `!==` self-consistency checks (§8), but
   confirming there is no other consumer requires searching the
   checkpoint/persistence cluster's files (`intrinsicCapacityPrefixes.ts`,
   checkpoint serialization code, `RunHistoryArchiveService.ts`, etc.),
   which are outside this cluster's assigned file list. **This directly
   determines whether the `localeCompare` hazard (§12, item 1) requires
   exact ICU-collation replication in Rust or can safely use a simpler,
   locale-independent total order.** Recommend the caches/checkpoint
   cluster's characterization explicitly confirm or deny this.
3. **Is the resolved default `Intl` locale guaranteed stable across every
   Node/Electron build this application ships on (dev machine, CI runner,
   packaged Electron production install, potentially different OS
   locales)?** This sandbox's empirical test (§12) showed `LANG` had no
   effect on `Intl.DateTimeFormat().resolvedOptions().locale` here, but that
   may be an artifact of this specific container's ICU configuration, not a
   guarantee that holds for every deployment target. If the answer to open
   question 2 is "no cross-boundary use," this question is moot for this
   cluster; if "yes," it becomes a real production-determinism question
   that predates this Rust port and may warrant a separate finding outside
   this document's scope.
4. **Does `GeometryKernel.Live`'s `validatePlacement` operation (wired to
   `PlacementValidation.validate`, §2) need a Rust equivalent for parity,
   given it has zero production callers today?** If the Rust N-API boundary
   (per the migration prompt's §7) exposes any `GeometryKernel`-shaped
   surface for testing/differential purposes, an equivalent is presumably
   still needed for interface completeness even though no Compact/Compact
   Short Side job reaches it. Recommend confirming with whoever owns the
   N-API contract design (Stage 1) whether `GeometryKernel`'s full Effect
   service shape is part of the Rust boundary or only the concrete
   operations actually reached by `computeIrregularNesting.ts`.
5. **Should the two independent `areDisjoint` copies (§12, item 7), the
   three independent `'placed translation must produce finite polygon
   coordinates.'` string literals (§11), and the two independent
   `pointIsOnSegment` copies be deliberately unified in the Rust port?**
   This document's position is that doing so is safe (no observable
   behavior change, all copies are byte-identical today) and reduces drift
   risk during translation — but since the migration prompt places a strong
   burden of proof on any change ("prove that it is completely unobservable
   and all differential gates remain exact"), flagging this explicitly for
   an orchestrator go/no-go rather than assuming it is in scope for this
   characterization document to decide.
6. **The `2^-450`/`2^500` linear-topology envelope bounds (§7) are not
   independently fuzzed at their exact boundary values** by
   `convexPolygonValidationTopology.test.ts` (whose "falls back to the
   historical sweep outside the safe numeric envelope" case at lines
   374-390 uses `Number.MAX_VALUE`/`Number.MIN_VALUE`/subnormal-adjacent
   values, well outside the `[2^-450, 2^500]` envelope, not values straddling
   it exactly). A Rust port reproducing these exact constants is correct by
   direct value-for-value translation, but there is no existing test that
   would catch an off-by-one-ULP error in the *envelope bounds themselves*
   (as opposed to the dispatch logic that uses them) — recommend a targeted
   boundary test (values just inside/outside `2^-450` and `2^500`) be added
   as part of Rust unit-test coverage per the migration prompt's §18.2.
