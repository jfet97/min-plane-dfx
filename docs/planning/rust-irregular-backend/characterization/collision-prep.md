# Characterization: Collision-Prep Cluster

Stage 0 characterization for the semantics-preserving Rust port. Cluster:
collision-geometry preparation, curve flattening, conservative padding/offset,
and transform generation (including the adaptive Compact transform policy).

Files read completely for this document:

- `src/workers/irregular/collisionGeometryBuilder.ts` (259 lines)
- `src/workers/irregular/transformGenerator.ts` (441 lines)
- `src/workers/irregular/arcFlattening.ts` (163 lines)
- `src/workers/irregular/ellipseFlattening.ts` (172 lines)
- `src/workers/irregular/clipper2OffsetAdapter.ts` (234 lines)
- `src/workers/irregular/clipper2OffsetPolicy.ts` (59 lines)
- `src/workers/irregular/convexPolygonOffset.ts` (65 lines)

Supporting files read in full or in relevant part to trace callers/callees
(not part of the "must read completely" set, and not exhaustively documented
here — they belong to other clusters):

- `src/workers/irregular/geometryKernel.ts`
- `src/workers/irregular/services.ts`
- `src/workers/irregular/convexPolygonValidation.ts`
- `src/workers/irregular/geometryPredicates.ts`
- `src/workers/irregular/internalGeometry.ts`
- `src/workers/irregular/convexHull.ts` (wrapper only; algorithm lives in
  `core/convexHullCore.ts`, not read)
- `src/shared/irregular/domain.ts` (relevant classes/schemas)
- `src/shared/irregular/defaults.ts`
- `src/shared/irregular/executionMode.ts`
- `src/workers/algorithm/irregular/computeIrregularNesting.ts` (caller site)
- `src/workers/nesting.worker.ts` (layer wiring)
- `src/renderer/utils/irregularSettingsUi.ts` (production preset source)
- `node_modules/.pnpm/clipper2-ts@2.0.1-18/.../dist/Clipper.js`,
  `Core.js` (pinned external dependency, version `2.0.1-18`, referenced
  because prompt section 8.3 requires reproducing its exact operations)
- `docs/prompts/fable5-rust-irregular-nesting-implementation.md`
  (sections 2, 8, 9, 13, 14, and others read in full)
- `docs/research/adaptive-compact-transform-policy.md` (read in full)

**Environment note relevant to this task's own instructions:** the migration
prompt (section 5) instructs the reader to start from `knowledge/INDEX.md` and
study pages under `knowledge/*.md` (e.g. `knowledge/adaptive-compact-transform-policy.md`).
No `knowledge/` directory exists anywhere in this repository checkout (`find`
from repo root returns nothing). The closest surviving artifact is
`docs/research/adaptive-compact-transform-policy.md`, which was used as the
substitute per this task's explicit instruction. This is a documentation-map
discrepancy, not a semantic one, but it should be resolved (repo reorganized,
or prompt corrected) before a Rust implementer tries to follow section 5
literally. See Open Questions.

---

## 1. Purpose and role in Compact / Compact Short Side execution

| Module | Purpose | Live on production Compact / Compact Short Side path? |
| --- | --- | --- |
| `collisionGeometryBuilder.ts` | Builds one piece's conservative, padded, convex collision polygon from imported source geometry: flatten → convex hull → normalize → offset → re-normalize to the placement-origin convention. | **Yes.** Called once per prepared piece from `computeIrregularNesting` (`src/workers/algorithm/irregular/computeIrregularNesting.ts:401-404`). |
| `transformGenerator.ts` | Generates the finite, deterministic set of rotation/mirror transform candidates for one piece's collision polygon, including the adaptive Compact edge/angle-tolerance policy. | **Yes.** Called once per prepared piece immediately after collision geometry build (`computeIrregularNesting.ts:408-414`). The adaptive-policy branch (`deriveEffectiveTransformPolicy`, `transformGenerator.ts:158-211`) is live whenever `intrinsicSharedArchiveEligibility(...).eligible` is true, which is the case for **both** production Compact and Compact Short Side default settings (see below). |
| `arcFlattening.ts` | Deterministic sagitta-tolerance sampling of DXF `ARC` segments and polyline bulge chords into polylines. | **Yes**, indirectly — invoked from `GeometryKernel.flattenSourceGeometry` (`geometryKernel.ts:150-158` for arcs, `geometryKernel.ts:136-144` for bulges), which is the first step `collisionGeometryBuilder.ts:70` calls. |
| `ellipseFlattening.ts` | Deterministic adaptive sampling of DXF `ELLIPSE` source curves preserved on line segments (`line.sourceCurve`). | **Yes**, indirectly — invoked from `geometryKernel.ts:126-134` inside the same `flattenSourceGeometry` step. |
| `clipper2OffsetAdapter.ts` | Runs exactly one Clipper2 `inflatePaths` convex offset through the integer `Paths64` API with full pre/post validation. Owns the `0.002mm` conservative offset allowance application point (via `conservativeOffsetMm`). | **Yes** — the only path to `inflatePaths` for collision-hull padding is `ConvexPolygonOffset.compute` → `Clipper2OffsetAdapter.compute`, reached from every `collisionGeometryBuilder.ts:79-82` call. |
| `clipper2OffsetPolicy.ts` | Declares the Clipper2 integer-grid policy tuple, and — far beyond the offset adapter — exports `toGridMm`/`fromGrid`, the canonical mm↔integer-grid conversion functions used **pervasively across the entire irregular pipeline** (NFP/IFP, canonical layout geometry, capacity material accounting, gap regions, transform collision geometry). See Purpose note below. | **Yes**, and more broadly than this cluster's scope suggests. |
| `convexPolygonOffset.ts` | Public validated boundary around `Clipper2OffsetAdapter`: validates the caller's convex input, restores the caller's original winding after Clipper2's forced CCW computation. | **Yes** — the only caller of `Clipper2OffsetAdapter.compute` in the whole repository (confirmed by grep; see §2). |

**Purpose note on `clipper2OffsetPolicy.ts` — broader than "collision-prep":**
`toGridMm`/`fromGrid`/`CLIPPER2_OFFSET_POLICY` (scale `1000`, i.e. a `0.001mm`
grid step) are imported by at least: `intrinsicCapacityMaterial.ts:3`,
`intrinsicGapRegions.ts:14`, `nfpIfpService.ts:42`, `canonicalLayoutGeometry.ts:17`,
`core/transformCollisionGeometryCore.ts:1`, and roughly a dozen more
`algorithm/irregular/intrinsic*.ts` files (confirmed by
`grep -rln "CLIPPER2_OFFSET_POLICY\|clipper2OffsetPolicy"`). This module is
effectively **the shared canonical-grid definition** for the whole irregular
engine, not a private detail of the initial offset. A Rust port must treat
`toGridMm`/`fromGrid`'s exact rounding rule (see §7) as a foundational,
widely-reused primitive, not something local to a "collision-prep" Rust
module. By contrast, `conservativeOffsetMm` (the `0.002mm` allowance) is used
**only** at `clipper2OffsetAdapter.ts:56` — it is genuinely local to this
cluster (confirmed: `grep -rn "conservativeOffsetMm" src` has exactly two
hits, the definition and this one call site).

**Production default confirms all of this cluster is live**, not experimental:
`DEFAULT_IRREGULAR_OPTIMIZER_SETTINGS = makeCompactQualityIrregularOptimizerSettings()`
(`src/shared/irregular/defaults.ts:177-178`), which sets
`intrinsicSharedArchiveEnabled: true`, `gaEnabled: false`, `baselineOnly: true`
(`defaults.ts:157-161`). `makeCompactShortSideIrregularOptimizerSettings`
(`defaults.ts:168-175`) layers `intrinsicObjectiveProfileId: 'short-side'` on
top of the same quality preset. The renderer's production UI entry points
`applyCompactQualityPreset` / `applyCompactShortSidePreset`
(`src/renderer/utils/irregularSettingsUi.ts:52-70`, consumed by
`src/renderer/components/IrregularSettingsPanel.vue`) construct settings
exclusively through these two maker functions. For the Short Side profile,
schema-level validation (`src/shared/irregular/domain.ts:436-455`) additionally
**forces** `intrinsicSharedArchiveEnabled === true` and GA-inactive whenever
`intrinsicObjectiveProfileId === 'short-side'` — so Compact Short Side can
never reach `transformGenerator.ts` with the adaptive policy disabled by
construction. For plain Compact, eligibility is not schema-enforced, only
convention-enforced by the presets, but the production default and the only
production preset both set it explicitly.

**Not on the production path:**

- `CollisionGeometryBuilder.Service.buildPieces` (`collisionGeometryBuilder.ts:104`,
  `Effect.forEach(inputs, buildPiece, { concurrency: 1 })`) has **zero**
  production callers. `grep -rn "buildPieces\b" src tests` shows only the
  interface declaration/implementation and one unit test
  (`tests/unit/collisionGeometryBuilder.test.ts:183`). Production code
  (`computeIrregularNesting.ts:389-431`) calls `buildPiece` one piece at a
  time inside a hand-written `for` loop, never the batch method. A Rust port
  does not need to reproduce `buildPieces` batch semantics for parity, though
  its existence documents an intended-but-unused parallel-safe shape (see §13).
- `CollisionGeometryBuilder.Unimplemented` / `GeometryKernel.Unimplemented`
  (`collisionGeometryBuilder.ts:112-118`, `geometryKernel.ts:200-209`) are
  Effect layers used only in tests to assert isolation from
  `GeometrySettings`/`GeometryKernel` (e.g.
  `tests/unit/collisionGeometryBuilder.test.ts:220-237`). Not reachable in
  production wiring (`nesting.worker.ts:391-398` always provides `.Live`).
- The **non-adaptive** branch of `deriveEffectiveTransformPolicy`
  (`transformGenerator.ts:163-169`, used when
  `intrinsicSharedArchiveEligibility(...).eligible` is `false`) is reachable
  in production only for the legacy/non-Compact worker mode, or if a caller
  constructs `IrregularOptimizerSettings` with `intrinsicSharedArchiveEnabled: false`
  or `gaEnabled: true`. It is not reachable for the two production Compact
  presets described above, but it is not dead code — it is the default
  behavior for every other irregular profile in the codebase and **must** be
  ported faithfully.

---

## 2. Entry points, callers, callees (traced, not guessed)

### `CollisionGeometryBuilder`

- Defined: `src/workers/irregular/collisionGeometryBuilder.ts:32-119` (Effect
  `Context.Service`).
- Constructed via `.Live` (`collisionGeometryBuilder.ts:109-111`, merges
  `GeometryKernel.Live`) or `.Unimplemented`.
- Callers (traced via grep, confirmed by reading each site):
  - `src/workers/nesting.worker.ts:391` — provides `.Live` for every irregular
    worker execution.
  - `src/workers/irregular/infrastructure.ts:14` — an alternate infrastructure
    layer bundle (not traced further; out of this cluster's file list, but
    confirmed to also wire `.Live`).
  - `src/workers/algorithm/irregular/computeIrregularNesting.ts:384,401-404` —
    the actual call site: `geometryBuilder.buildPiece({ piece: source, totalPaddingMm: request.padding })`
    inside the per-piece preparation loop (`computeIrregularNesting.ts:389-431`).
- Callees: `GeometryKernel.flattenSourceGeometry`, `GeometryKernel.convexHull`,
  `GeometryKernel.offsetConvexPolygon` (all via the injected `geometryKernel`
  service, `collisionGeometryBuilder.ts:57,70,73,79-82`).

### `TransformGenerator`

- Defined as an Effect `Context.Service` interface in `services.ts:262` and
  `services.ts:387-421`; concrete implementation `TransformGeneratorLive`
  (`transformGenerator.ts:50-52`) wraps the pure function `generateTransforms`
  (`transformGenerator.ts:70-122`).
- Callers:
  - `src/workers/nesting.worker.ts:392` — provides `TransformGeneratorLive`.
  - `src/workers/irregular/infrastructure.ts:15` — same, alternate bundle.
  - `src/workers/algorithm/irregular/computeIrregularNesting.ts:386,408-414` —
    the actual call site, immediately after `buildPiece` for the same prepared
    piece, in the same loop iteration.
- Callees: `ConvexPolygonValidation.validateStrictBoundary` (transform
  generator only, for the incoming `collisionPolygon.points`),
  `intrinsicSharedArchiveEligibility` (`@shared/irregular/executionMode.js`).
  `generateTransforms` performs its own `Schema.decodeUnknownExit(GenerateTransformsInput)`
  (`transformGenerator.ts:244-249`) — it re-validates/re-decodes the entire
  `CollisionGeometrySchema` + settings on every call; it does not trust the
  caller's already-constructed domain objects.

### `arcFlattening.ts` / `ellipseFlattening.ts`

- Exported as plain object namespaces `ArcFlattening` (`arcFlattening.ts:7-11`)
  and `EllipseFlattening` (`ellipseFlattening.ts:12-14`); no Effect service
  wrapper, no DI — pure synchronous functions.
- Sole caller of both: `GeometryKernel.flattenSourceGeometry`
  (`geometryKernel.ts:115-169`), which `Match`-dispatches on
  `piece.geometry.segments` by `segment.kind`:
  - `kind: 'line'` with `line.sourceCurve !== undefined` →
    `EllipseFlattening.samplePoints(sourceCurve, sagToleranceMm)`
    (`geometryKernel.ts:126-129`), gated by a `sampledSourceCurves` `Set<string>`
    that skips a curve already sampled by `sourceCurve.sourceId`
    (`geometryKernel.ts:117,123-125`) — this is a curve-level (not
    segment-level) dedup: multiple line segments sharing one `sourceCurve.sourceId`
    only get flattened once, and only the **first** segment in iteration order
    that references that curve triggers the sampling.
  - `kind: 'line'` with `line.bulge !== undefined && line.bulge !== 0` →
    `ArcFlattening.sampleBulgePoints(line, sagToleranceMm)`
    (`geometryKernel.ts:136-144`).
  - `kind: 'line'` otherwise → the two raw endpoints, no curve sampling
    (`geometryKernel.ts:147-148`).
  - `kind: 'arc'` → `ArcFlattening.samplePoints(arc, sagToleranceMm)`
    (`geometryKernel.ts:150-158`).
  - `Match.exhaustive` (`geometryKernel.ts:159`) — TypeScript compile-time
    guarantee that `DxfGeometrySegment` has exactly these two `kind` values
    today; a Rust port's segment enum match must be kept exhaustive too.

### `clipper2OffsetAdapter.ts` / `clipper2OffsetPolicy.ts` / `convexPolygonOffset.ts`

- `ConvexPolygonOffset.compute` (`convexPolygonOffset.ts:18-28`) is the
  **only** caller of `Clipper2OffsetAdapter.compute`
  (confirmed: `grep -rln "Clipper2OffsetAdapter\b" src` → only
  `convexPolygonOffset.ts` and its own definition file).
- `GeometryKernel.offsetConvexPolygon` (`geometryKernel.ts:171-178`) is the
  **only** caller of `ConvexPolygonOffset.compute`
  (confirmed: `grep -rln "ConvexPolygonOffset\b" src` → only `geometryKernel.ts`
  and its own definition file).
- `clipper2OffsetPolicy.ts`'s `toGridMm`/`fromGrid` are called from within
  `clipper2OffsetAdapter.ts` itself (grid quantization/dequantization of
  polygon vertices and the offset distance) **and** independently from ~15
  other `algorithm/irregular/intrinsic*.ts` and `irregular/*.ts` files across
  the rest of the codebase (listed in §1). Those other call sites are outside
  this cluster's required-reading scope and are not further analyzed here.

### External dependency: `clipper2-ts@2.0.1-18`

`clipper2OffsetAdapter.ts:1-10` imports `area`, `EndType`, `inflatePaths`,
`isPositive`, `JoinType`, and the `Path64`/`Point64`/`Paths64` types from the
pinned npm package `clipper2-ts` version `2.0.1-18`
(`CLIPPER2_OFFSET_POLICY.backendVersion`, `clipper2OffsetPolicy.ts:8`). This
is a real, load-bearing external dependency whose exact arithmetic (see §7)
must be reproduced or matched by whatever Rust Clipper2 binding/port is
chosen, per prompt §8.3's "verify that it reproduces the existing
`clipper2-ts` operations... exactly" requirement.

---

## 3. Data in/out: exact types/shapes, optional-field presence/omission semantics

### `CollisionGeometryBuilder.buildPiece`

- Input `BuildCollisionGeometryInput` (`services.ts:95-98`):
  `{ piece: ImportedPiece; totalPaddingMm: number }`. Not a `Schema.Struct` —
  plain TS interface, no runtime decoding at this call boundary (trusted,
  already-decoded caller data).
- Output `CollisionGeometry` (`domain.ts:572-598`, plain class, **not**
  `Schema.Class` — constructing `new CollisionGeometry(...)` performs **no**
  runtime schema validation; `CollisionGeometrySchema`, `domain.ts:554-569`,
  is a separate struct used only where the collision geometry crosses a
  schema-decode boundary, e.g. inside `GenerateTransformsInput`,
  `services.ts:117-123`):
  - `sourcePieceId: PieceId` — from `input.piece.id` (`collisionGeometryBuilder.ts:92`).
  - `sourceBounds: IrregularBounds` — unpadded convex-hull bounds in original
    source coordinates (`collisionGeometryBuilder.ts:93`, computed in
    `normalizeHull`, `collisionGeometryBuilder.ts:140-163`).
  - `sampledPoints: ReadonlyArray<IrregularPoint>` — the flattened source
    samples, **in original source coordinates**, unmodified by hull/offset
    normalization (`collisionGeometryBuilder.ts:94`, `flattened.sampledPoints`
    straight from `GeometryKernel.flattenSourceGeometry`). Kept "for debug and
    export traceability" per the comment at `collisionGeometryBuilder.ts:69`.
  - `convexHull: IrregularPolygon` — the source convex hull, rebased twice:
    once to its own bounds minimum in `normalizeHull`
    (`collisionGeometryBuilder.ts:129-164`), then translated again to the
    **collision polygon's** bounds minimum in `normalizeCollisionGeometry`
    (`collisionGeometryBuilder.ts:174-194`). Its local origin is therefore
    **not** `(0,0)` in general — only the `collisionPolygon`'s lower-left
    bound is `(0,0)`.
  - `collisionPolygon: IrregularPolygon` — the padded, offset polygon,
    translated so its own bounds minimum is exactly `(0,0)`
    (`collisionGeometryBuilder.ts:184-188`). This is "the single placement
    point convention for v2" per the docstring at `collisionGeometryBuilder.ts:166-172`.
  - `placementReference: IrregularPoint` — **source-space** coordinate of the
    padded collision-bounds corner
    (`sourceBounds.minX + collisionBounds.minX`, `sourceBounds.minY + collisionBounds.minY`,
    `collisionGeometryBuilder.ts:189-192`). Explicitly documented as possibly
    lying **outside cut material** because padding is included
    (`collisionGeometryBuilder.ts:171-172`).
  - `diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>` — always exactly
    `[...flattened.diagnostics, ...importWarningDiagnostics(input.piece)]`
    (`collisionGeometryBuilder.ts:98`). **`flattened.diagnostics` is always
    `[]`** — `GeometryKernel.flattenSourceGeometry`'s only live implementation
    hard-codes `diagnostics: []` (`geometryKernel.ts:162-168`); nothing in
    `arcFlattening.ts` or `ellipseFlattening.ts` produces diagnostics. So in
    the current codebase, `CollisionGeometry.diagnostics` is **always exactly**
    `importWarningDiagnostics(input.piece)` — one `CollisionGeometryDiagnostic`
    per `piece.warnings` entry, same order, with `pieceId` **always present**
    (never omitted — `importWarningDiagnostics`, `collisionGeometryBuilder.ts:229-238`,
    always supplies `pieceId: piece.id`). A Rust port must still carry the
    (currently always-empty) `flattened.diagnostics` concatenation path
    faithfully, since `flattenSourceGeometry` is a documented extension point.
  - `CollisionGeometryDiagnostic.pieceId` is the one field in this cluster's
    output types with real omission semantics: its class constructor
    (`domain.ts:508-524`) uses `Object.prototype.hasOwnProperty.call(fields, 'pieceId')`
    to decide whether to assign the property at all — an **absent** key
    produces no own `pieceId` property (`declare readonly pieceId?: PieceId | undefined`,
    `domain.ts:511`), distinct from a present-but-`undefined` value. Every
    call site in this cluster always supplies `pieceId`, so the omitted case
    is not exercised here, but must still be reproduced exactly if any
    downstream code (JSON serialization, hashing) distinguishes "key absent"
    from "key present with `undefined`"/`null`.

### `GeometryKernel.offsetConvexPolygon` (through `collisionGeometryBuilder.ts:79-82`)

- Input `OffsetConvexPolygonInput` (`services.ts:105-109`) — an actual
  `Schema.Struct` (`polygon: IrregularPolygonSchema`,
  `totalPaddingMm: NonNegativeFiniteMillimeters`), decoded at
  `geometryKernel.ts:246-258` before use. A negative `totalPaddingMm` is
  rejected here (confirmed by test
  `tests/unit/irregularGeometryKernel.test.ts:270` "rejects a negative
  padding value through the offset input schema").
- `computeCollisionOffsetMm` (`geometryKernel.ts:230-243`): `distanceMm = totalPaddingMm / 2 + settings.clearanceSafetyMarginMm`.
  `totalPaddingMm` itself is constrained upstream at the request schema level
  to `NonNegativeIntegerMillimeters` (`src/shared/domain/nesting.ts:127`,
  confirmed non-negative **integer** mm), so `totalPaddingMm / 2` is always an
  exact dyadic fraction (no rounding hazard from this division specifically).
- `ConvexPolygonOffset.compute(polygon, distanceMm)` →
  `Clipper2OffsetAdapter.compute({ polygon, distanceMm })` →
  `Effect<IrregularPolygon, IrregularGeometryInputError>`.

### `TransformGenerator.generateTransforms`

- Input `GenerateTransformsInput` (`services.ts:117-123`, a real
  `Schema.Struct`): `{ geometry: CollisionGeometrySchema; allowRotation: boolean; allowMirror: boolean; geometrySettings: IrregularGeometrySettings; settings: IrregularOptimizerSettings }`.
- Output: `ReadonlyArray<IrregularTransformCandidate>`
  (`domain.ts:248-273`), each with `{ index: number (>=0 int); rotationDeg: number; mirrored: boolean; reason: 'orthogonal' | 'edge_alignment' | 'configured' }`.
  `index` is assigned strictly by final output-array position
  (`transformGenerator.ts:110-118`), post-cap, post-dedup — not by any
  intermediate ordinal.

### `arcFlattening.ts` / `ellipseFlattening.ts` I/O

- `ArcFlattening.samplePoints(arc: DxfArcSegment, sagToleranceMm: number): ReadonlyArray<IrregularPoint>`
  (`arcFlattening.ts:14-45`). Always returns **at least 2** points (imported
  start + imported end, `arcFlattening.ts:21,42`); interior samples are
  `sampleCount - 1` additional analytic points when `sampleCount > 1`.
- `ArcFlattening.sampleBulgePoints(segment: DxfLineSegment, sagToleranceMm: number): ReadonlyArray<IrregularPoint>`
  (`arcFlattening.ts:54-76`). Also always returns at least 2 points; if
  `bulgeArcParameters` returns `null` (bulge `undefined`/`0`, or a degenerate
  chord/radius/sweep — `arcFlattening.ts:88-105`) it degrades to a straight
  2-point chord (`arcFlattening.ts:60-63`).
- `EllipseFlattening.samplePoints(ellipse: DxfEllipseSource, sagToleranceMm: number): ReadonlyArray<IrregularPoint>`
  (`ellipseFlattening.ts:24-61`). **Returns an empty array `[]`** — not even
  the start point — when `sweep <= 0` or `majorAxisLength <= 0` or either is
  non-finite (`ellipseFlattening.ts:30-32`). This is a real behavioral
  asymmetry versus `ArcFlattening`, which never returns fewer than 2 points.
  Flagged as a port risk in §12/§15.

### `clipper2OffsetAdapter.ts` I/O

- Input `Clipper2OffsetInput` (private interface, `clipper2OffsetAdapter.ts:22-26`):
  `{ polygon: IrregularPolygon; distanceMm: number }` (`distanceMm` is
  documented as "derived non-negative" but the function does not itself
  reject a negative `distanceMm` beyond what `toGridMm`/grid-guard checks
  would catch — negativity enforcement happens upstream at
  `OffsetConvexPolygonInput`'s schema, not here).
- Output: `Effect<IrregularPolygon, IrregularGeometryInputError>` — exactly
  one simple, convex, CCW, finite polygon whose vertex order starts at the
  "stable" lowest-then-leftmost vertex (`rotateToStableStart`,
  `clipper2OffsetAdapter.ts:205-217`).

---

## 4. Algorithm state and every mutation point

This cluster is almost entirely **pure/stateless per call** — no
long-lived mutable service state, no caches (see §9). Mutation is limited to
local accumulator variables inside single function calls:

- `normalizeHull` (`collisionGeometryBuilder.ts:129-164`): local `minX, minY,
  maxX, maxY` accumulated via `Math.min`/`Math.max` over `sourceHull.points`
  (`collisionGeometryBuilder.ts:150-153`), reduced left-to-right in array
  order (order does not affect the min/max result, but does affect NaN
  short-circuit timing if ever relevant — it is not, since the loop already
  early-returns on the first non-finite point via `Effect.succeed`/`return`
  inside the loop, `collisionGeometryBuilder.ts:146-148`).
- `boundsForPolygon` (`collisionGeometryBuilder.ts:196-215`): same
  min/max-accumulation pattern, seeded from `points[0]` then folded over
  `points.slice(1)` (`collisionGeometryBuilder.ts:202-212`) — note the extra
  intermediate array allocation from `.slice(1)`, a pure inefficiency
  preserved as-is per the "preserve inefficient behavior" mandate.
- `GeometryKernel.flattenSourceGeometry`'s `makePointsStore()` closure
  (`geometryKernel.ts:96-112`): mutable `points: IrregularPoint[]` array plus
  a `seen: Set<`${number}:${number}`>` keyed by **exact** `"x:y"` string
  (template-literal `Number`→string coercion, not a rounded/quantized key).
  `.push(x,y)` is a no-op if the exact key was already seen
  (`geometryKernel.ts:100-106`); `.get()` returns a **shallow copy**
  (`[...points]`, `geometryKernel.ts:108-110`) of accumulated points in
  first-seen order. This is the single dedup point across the whole
  `flattenSourceGeometry` call — it operates across **all** segments of a
  piece, not per-segment, so a duplicate point emitted by two different
  segments (e.g. a shared vertex) is coalesced into one. The dedup key is
  exact floating-point equality on both coordinates — no tolerance.
- `transformGenerator.ts`'s `deriveUsableEdges`
  (`transformGenerator.ts:252-284`): local `usableEdges: UsableEdge[]`,
  appended in polygon-edge order (index `0..points.length-1`).
- `deduplicateAngles` (`transformGenerator.ts:286-317`): local `normalized:
  AngleCandidate[]` (rebuilt from `rawCandidates` with each `rotationDeg`
  normalized), then sorted in place
  (`normalized.sort(compareRepresentativeSignificance)`,
  `transformGenerator.ts:299`) — **mutates the local array via `Array.sort`**,
  which in current V8/Node is a stable sort (see §12), then a `retained:
  AngleCandidate[]` accumulator filled by scanning `normalized` once
  (`transformGenerator.ts:301-313`), then `retained.sort(compareOutputOrder)`
  (`transformGenerator.ts:315`) — a **second** in-place stable sort with a
  **different** comparator (see §6).
- `selectTransformChoices` (`transformGenerator.ts:352-384`): `selected:
  TransformChoice[]` built via `.slice`/`.push`, and (conditionally)
  `extraChoices: TransformChoice[]` built by repeated
  `appendDistinctChoice(...)` calls (`transformGenerator.ts:386-401`), each of
  which does a linear `Array.prototype.some` scan over the **current**
  contents of the target array before pushing — an O(n²) dedup pattern
  preserved as-is.
- `clipper2OffsetAdapter.ts`'s `toIntegerPath`
  (`clipper2OffsetAdapter.ts:110-139`): local `path: Path64` built
  incrementally; consecutive-duplicate suppression via `path.at(-1)`
  comparison (`clipper2OffsetAdapter.ts:127-129`) — **only adjacent**
  duplicates are suppressed here (unlike `makePointsStore`'s global `Set`,
  this is a linear scan against only the immediately preceding pushed point);
  then explicit removal of a closing duplicate if `first === last`
  (`clipper2OffsetAdapter.ts:132-136`).
- `validatePath` (`clipper2OffsetAdapter.ts:142-166`): a **fresh**
  `uniquePoints: Set<string>` per call, keyed by the exact integer
  `"x:y"` string — this one **does** check all pairs (global uniqueness), not
  just adjacent ones, so it can reject a path `toIntegerPath` accepted (e.g. a
  polygon that visits the same integer grid point twice non-consecutively).
- `Clipper2OffsetAdapter.compute`'s `offsetPaths` (`clipper2OffsetAdapter.ts:64-76`):
  a `try/catch` around the single external `inflatePaths(...)` call — the
  **only** call into Clipper2 in this whole cluster; its internal state is
  entirely external-library-owned and out of scope for this document, but its
  algorithm is required to be reproduced/matched by whatever Rust binding is
  chosen (§8.3 of the migration prompt).
- No module in this cluster holds cross-call mutable state (no module-level
  `let`, no closures captured outside a single function invocation, no
  singleton caches). Everything a Rust port needs is fully determined by the
  arguments of a single call.

---

## 5. Ordering sources

- **`GeometryKernel.flattenSourceGeometry`'s `pointsStore`** — insertion order
  = first-seen order across `piece.geometry.segments` in their given array
  order (`geometryKernel.ts:119`). This order flows directly into
  `CollisionGeometry.sampledPoints` and is observable in
  `CollisionGeometry` output/history/debug artifacts (per
  `collisionGeometryBuilder.ts:94`'s docstring "kept... for debug and export
  traceability").
- **`sampledSourceCurves: Set<string>`** (`geometryKernel.ts:117`) — governs
  which segment among several sharing one `sourceCurve.sourceId` actually
  triggers ellipse sampling; insertion order is segment-array order, and the
  Set's membership (not iteration) is the only thing consulted
  (`geometryKernel.ts:123-125`), so Set iteration order is not itself an
  observable ordering source here.
- **`normalizeHull`'s `sourceHull.points.map(...)`** (`collisionGeometryBuilder.ts:159-162`)
  preserves `ConvexHull.compute`'s output order exactly (translation only, no
  reordering). `ConvexHull.compute`'s own ordering guarantee ("sorted by X
  then Y first... deterministic counter-clockwise boundary convention",
  `convexHull.ts:10-13`) is defined in `core/convexHullCore.ts`, outside this
  cluster's read scope — treat it as an external ordering contract to verify
  in the cluster that owns `convexHullCore.ts`.
- **`translatePolygon`** (`collisionGeometryBuilder.ts:217-227`) is a pure
  `.map`, index-preserving.
- **`transformGenerator.ts` sort #1 — `compareRepresentativeSignificance`**
  (`transformGenerator.ts:319-334`), applied at `transformGenerator.ts:299`.
  Determines **which** candidate in a near-angle cluster is retained (see §6).
- **`transformGenerator.ts` sort #2 — `compareOutputOrder`**
  (`transformGenerator.ts:336-344`), applied at `transformGenerator.ts:315`.
  Determines the **final emitted order** of retained candidates before
  `selectTransformChoices` runs. Both sorts rely on JS `Array.prototype.sort`
  being a **stable** sort (guaranteed since ECMAScript 2019 / all currently
  supported Node versions) — ties that the comparator reports as `0` preserve
  the pre-sort relative order. This matters because
  `compareRepresentativeSignificance`'s final tie-break is
  `first.sourceOrdinal - second.sourceOrdinal` (`transformGenerator.ts:333`),
  which is already **injective** within a reason group (edge_alignment
  `sourceOrdinal` = polygon edge index, unique per edge; orthogonal
  `sourceOrdinal` ∈ {0,1,2,3}; configured `sourceOrdinal` = array index) — so
  in practice this comparator never actually returns `0` for two **distinct**
  candidates of the same reason (rotation collisions between different edges
  at the exact same angle would still be broken by `sourceOrdinal`). Stability
  reliance is real but currently inert for this specific comparator; still,
  a Rust port must use a stable sort (`slice::sort_by`, not `sort_unstable_by`)
  to preserve behavior under any future comparator change or edge case not
  covered by current tests.
- **`selectTransformChoices`'s `angles` parameter order**
  (`transformGenerator.ts:352`) is exactly `candidates.value`'s post-sort-#2
  order. `baseline = angles.filter(reason === 'orthogonal')`
  (`transformGenerator.ts:358`) and the non-orthogonal filters
  (`transformGenerator.ts:365,374`) preserve relative order (`Array.filter`
  is order-preserving).
- **`extraChoices` build order** (`transformGenerator.ts:373-380`): for each
  non-orthogonal candidate **in output order**, append its **mirrored**
  variant first, then its **unmirrored** variant
  (`transformGenerator.ts:375-376`) — interleaved per-candidate, not grouped
  as "all mirrored, then all unmirrored." Then, for each **orthogonal**
  candidate in order, append only its mirrored variant
  (`transformGenerator.ts:378-379`). This exact interleaving determines which
  candidates survive `slice(0, transformCap - selected.length)`
  (`transformGenerator.ts:382`) when the cap is tight — order-sensitive and
  must be reproduced exactly, not just "the same set."
- **Final `index` assignment** (`transformGenerator.ts:110-118`): a plain
  `.map((candidate, index) => ...)` over the final `selectedCandidates` array
  — index is positional, not carried from any earlier ordinal.
- **`clipper2OffsetAdapter.ts`'s `rotateToStableStart`**
  (`clipper2OffsetAdapter.ts:205-217`) and **`convexPolygonOffset.ts`'s**
  near-identical duplicate `rotateToStableStart`
  (`convexPolygonOffset.ts:42-54`) both pick the vertex with the
  **lowest `y`, then lowest `x`** as the new array start (`< `, strict,
  first-seen-wins on exact ties per the loop's `if` using only `<`, not `<=`,
  `clipper2OffsetAdapter.ts:211`/`convexPolygonOffset.ts:48`), and rotate the
  array (not reverse it) to start there. These are two independently
  maintained, structurally identical implementations over different point
  types (`Path64`/integer vs `IrregularPoint`/float) — worth collapsing into
  one shared Rust helper, but the TS duplication itself carries no semantic
  divergence risk since both loops are byte-for-byte the same algorithm.
- **`toIntegerPath`'s adjacent-dedup + closing-duplicate removal**
  (`clipper2OffsetAdapter.ts:110-139`) is order-preserving over the canonical
  (possibly-reversed) input order.
- **`validatePath`'s `uniquePoints: Set<string>`** (`clipper2OffsetAdapter.ts:145-154`)
  — only used for membership testing (rejection), never iterated; insertion
  order is not an observable ordering source here.

No `Map`/`Set` in this cluster is ever **iterated** to produce output order —
every `Set` here (`sampledSourceCurves`, `seen` in `makePointsStore`,
`uniquePoints` in `validatePath`) is used purely for membership testing. This
is a favorable finding: none of `HashMap`/`HashSet`'s Rust non-determinism
risk (prompt §9) applies directly inside this cluster's own logic. It does
apply to the array-based orderings above, which must become `Vec`s with
explicit stable sorting in Rust.

---

## 6. Comparators and tie rules: exact comparison chains, signs, tie-breakers

### `compareRepresentativeSignificance` (`transformGenerator.ts:319-334`)

Used to decide **which candidate survives** a near-angle dedup cluster
(earlier-sorted element wins by being pushed into `retained` first; later
near-duplicates are dropped by the `retained.some(...)` scan at
`transformGenerator.ts:302-311`).

1. `reasonPriority(first.reason) - reasonPriority(second.reason)`
   (`transformGenerator.ts:323-324`), where `reasonPriority` is
   `orthogonal → 0`, `edge_alignment → 1`, `configured → 2`
   (`transformGenerator.ts:411-420`). **Ascending**: `orthogonal` beats
   `edge_alignment` beats `configured`.
2. If **both** are `edge_alignment`: `second.edgeLengthMm - first.edgeLengthMm`
   (`transformGenerator.ts:326-329`). A **positive** result means `first`
   sorts after `second`, i.e. **the longer edge wins** (sorts first, is
   retained). This matches the research doc's documented rule ("two
   competing edge-derived angles keep the contributor from the longer usable
   collision edge").
3. `first.rotationDeg - second.rotationDeg` (`transformGenerator.ts:331-332`)
   — ascending numeric rotation.
4. `first.sourceOrdinal - second.sourceOrdinal` (`transformGenerator.ts:333`)
   — ascending; final deterministic tie-break, always injective in practice
   within one reason group (see §5).

### `compareOutputOrder` (`transformGenerator.ts:336-344`)

Used for the **final emitted order** of retained candidates, applied
**after** dedup. Same four-key structure but with **step 2 and step 3
swapped relative to significance sort**:

1. `reasonPriority(first.reason) - reasonPriority(second.reason)`
   (`transformGenerator.ts:337-338`) — identical to above.
2. `first.rotationDeg - second.rotationDeg`
   (`transformGenerator.ts:339-340`) — **rotation compared before length
   here**, unlike the significance comparator.
3. `second.edgeLengthMm - first.edgeLengthMm`
   (`transformGenerator.ts:341-342`) — longer-edge-first, but only used as a
   tie-break **after** rotation, i.e. only distinguishes two same-reason
   candidates that happen to share the exact same `rotationDeg` (e.g. two
   distinct polygon edges that are exactly antiparallel/parallel after
   `normalizeRotationDeg`, or two duplicate configured angles that survived
   dedup by being far enough apart from each other but coincidentally equal —
   not possible for `configured` since duplicates there are also collapsed,
   but structurally reachable for `edge_alignment` if two edges happen to
   produce numerically identical normalized rotations while both exceeding
   the dedup tolerance from every other retained candidate — an edge case,
   but the comparator chain must still be reproduced exactly for it).
4. `first.sourceOrdinal - second.sourceOrdinal` (`transformGenerator.ts:343`).

**These two comparators are deliberately different, not interchangeable.** A
Rust implementer must keep them as two distinct functions; collapsing them
into one "shared" comparator would silently change the surviving-vs-dropped
outcome for near-tie clusters and possibly the final output order for exact
`rotationDeg` ties.

### `deduplicateAngles`'s retention predicate (`transformGenerator.ts:302-311`)

```
retained.some(existing =>
  !(candidate.reason === 'orthogonal' && existing.reason === 'orthogonal') &&
  circularDistanceDeg(existing.rotationDeg, candidate.rotationDeg) <= toleranceDeg
)
```

- Orthogonal-vs-orthogonal pairs are **exempt** from the near-angle
  suppression check (the `!(both orthogonal)` guard) — the four orthogonal
  rotations (or one, if `allowRotation` is false) are **never** treated as
  duplicates of each other regardless of `toleranceDeg`. This only matters in
  principle if `toleranceDeg` ever exceeded 90°, which the adaptive formula's
  cap of `0.051°` (`COMPACT_MAXIMUM_ANGLE_DEDUPLICATION_DEG`,
  `transformGenerator.ts:17`) and the persisted-path default (`0.01°`,
  `domain.ts:337-339`) never approach — but the exemption is still an
  explicit, deliberate rule that must be ported exactly, not simplified away
  as "obviously never triggered."
- A **non**-orthogonal candidate that lands within `toleranceDeg` of an
  **already-retained orthogonal** candidate **is** suppressed (the guard only
  exempts orthogonal-vs-orthogonal, not orthogonal-vs-other).
- Comparison is `<=` (inclusive) against `toleranceDeg`, using
  `circularDistanceDeg` (`transformGenerator.ts:422-425`):
  `min(|a-b|, 360 - |a-b|)`, operating on **already-normalized** `[0,360)`
  rotations (normalization happens per-candidate at
  `transformGenerator.ts:292-297`, before the sort).

### `appendDistinctChoice`'s dedup predicate (`transformGenerator.ts:386-401`)

```
choices.some(existing =>
  existing.mirrored === candidate.mirrored &&
  circularDistanceDeg(existing.rotationDeg, candidate.rotationDeg) <= toleranceDeg
)
```

- Only compares within the **same mirror state** — a mirrored candidate is
  never suppressed by an unmirrored near-duplicate or vice versa.
- Only checks against the **local `extraChoices` accumulator**, never against
  the already-committed `selected`/`baselineChoices` array. Because
  `deduplicateAngles` already ran globally before `selectTransformChoices`,
  unmirrored non-orthogonal candidates reaching this function are already
  guaranteed non-near-duplicate of any orthogonal baseline angle. **Mirrored**
  edge-derived angles are a **new** derived value (`180 - rotationDeg`,
  computed fresh in `toTransformChoice`, `transformGenerator.ts:403-409`) that
  was never subject to the earlier global dedup pass, so a mirrored edge
  angle **could** in principle coincide with (or land within tolerance of) an
  orthogonal angle already in `selected`, and nothing here would catch that.
  This is exact, intentional (or at least currently-accepted) TS behavior
  that must be preserved bit-for-bit, not treated as a bug to fix.

### `toTransformChoice`'s mirror rotation rule (`transformGenerator.ts:403-409`)

```
rotationDeg = mirrored && reason === 'edge_alignment'
  ? normalizeRotationDeg(180 - candidate.rotationDeg) ?? candidate.rotationDeg
  : candidate.rotationDeg
```

- Mirroring an **`edge_alignment`** candidate reflects its rotation via
  `180 - rotationDeg` (then renormalizes to `[0,360)`) — this is the formula
  that "makes the mirrored edge horizontal" (confirmed by the test at
  `tests/unit/transformGenerator.test.ts:253-274`, which asserts the
  transformed mirrored polygon's first two points share the same `y`).
- Mirroring an **`orthogonal`** or **`configured`** candidate leaves
  `rotationDeg` numerically **unchanged** — only the `mirrored` flag differs.
  This is a non-obvious, easy-to-miss detail: a Rust implementer who assumes
  "mirroring always reflects the angle" would produce wrong `configured`-reason
  mirrored candidates.
- The `?? candidate.rotationDeg` fallback (`transformGenerator.ts:406`) is
  unreachable in current code: `180 - candidate.rotationDeg` is always finite
  because `candidate.rotationDeg` was already validated finite earlier in the
  pipeline, so `normalizeRotationDeg` never returns `undefined` here. Preserve
  it anyway for exact structural parity; it costs nothing and matches the
  "don't clean up observable-adjacent code" mandate.

### `normalizeRotationDeg` (`transformGenerator.ts:427-433`)

```
if (!Number.isFinite(rotationDeg)) return undefined
const remainder = rotationDeg % 360
const normalized = remainder < 0 ? remainder + 360 : remainder
return Object.is(normalized, -0) ? 0 : normalized
```

- Explicit NaN/Infinity rejection (`Number.isFinite`).
- JS `%` is a truncating remainder (sign follows dividend), so
  `-360 % 360 === -0` — the explicit `Object.is(normalized, -0) ? 0 : normalized`
  guard exists specifically to prevent `-0` from becoming an observable
  rotation value. This is a deliberate signed-zero normalization the prompt
  (§8.1) calls out generically; here is its concrete instance.

### `rotateToStableStart` tie rule (both copies)

`candidate.y < current.y || (candidate.y === current.y && candidate.x < current.x)`
— strict `<`, so on an **exact** tie the **earliest-index** point in the
original array wins (first-seen-wins; the comparison never updates
`startIndex` for an exact duplicate coordinate pair later in the array).

---

## 7. Numeric semantics

### Signed zero

- `normalizeRotationDeg` explicitly collapses `-0 → 0` (`transformGenerator.ts:432`,
  see §6). No other function in this cluster does an equivalent explicit
  `Object.is(..., -0)` guard, but several arithmetic paths **can produce**
  `-0` and let it propagate:
  - `toGridMm(valueMm)` (`clipper2OffsetPolicy.ts:44-53`): `gridValue = Math.sign(valueMm) * roundedAbsoluteValue`.
    `Math.sign(-0) === -0` and `Math.sign(0) === 0`
    (positive zero). For `valueMm = -0`, `roundedAbsoluteValue = Math.floor(0 + 0.5) = 0`,
    so `gridValue = -0 * 0`. IEEE-754 multiplication sign is the XOR of
    operand signs: `-0 * 0 === -0` in JS. So **`toGridMm(-0)` returns `-0`**,
    while `toGridMm(0)` returns `0`. `Number.isSafeInteger(-0) === true`, so
    this passes the safety check unchanged. `fromGrid(-0) = -0 / 1000 = -0`
    (division by a positive number preserves the numerator's sign for zero).
    A vertex coordinate can therefore legitimately be `-0` after a
    quantize/dequantize round-trip. **This must be reproduced bit-for-bit in
    Rust** (`f64` also has signed zero and the same IEEE rules for `*` and
    `/`), and any place that *stringifies* a coordinate for a cache key or
    hash must match JS's `String(-0) === "0"` behavior (JS `${-0}` collapses
    to `"0"`, losing the sign in string form) versus Rust's default
    `format!("{}", -0.0_f64)` which prints `"-0"` — a real divergence risk if
    any canonical string key in a *different* cluster stringifies raw
    coordinates without normalizing `-0` first. Flagged for cross-cluster
    attention (not resolved inside this cluster's files).
  - `deriveUsableEdges`'s `directionDeg`/`rotationDeg` derivation
    (`transformGenerator.ts:265-276`) uses `Math.atan2` and negation; `atan2`
    can return `-0` for specific inputs, feeding into
    `normalizeRotationDeg`'s explicit `-0` guard (so this particular path is
    already covered).

### NaN / infinity rejection

- `normalizeHull` (`collisionGeometryBuilder.ts:146-148`) rejects any
  non-finite `point.x`/`point.y` with a typed error before any arithmetic.
- `boundsForBoundary` (`transformGenerator.ts:213-239`) computes
  `widthMm`/`heightMm` first, **then** checks `Number.isFinite` on the
  results (`transformGenerator.ts:234-236`) — it does not check individual
  input coordinates for finiteness before subtracting; relies on the
  subtraction itself producing `NaN`/`Infinity` if inputs were pathological
  (in practice unreachable here because `boundary` was already validated
  finite by `ConvexPolygonValidation.validateStrictBoundary` at
  `transformGenerator.ts:76-77` before `deriveEffectiveTransformPolicy` runs).
- `deriveEffectiveTransformPolicy` (`transformGenerator.ts:158-211`) checks
  `Number.isFinite(minimumEdgeLengthMm)`, `minimumEdgeLengthMm < 0`,
  `Number.isFinite(angleDeduplicationToleranceDeg)`,
  `angleDeduplicationToleranceDeg <= 0` all together
  (`transformGenerator.ts:196-203`) before accepting the derived policy —
  note `angleDeduplicationToleranceDeg <= 0` is rejected (must be strictly
  positive), while `minimumEdgeLengthMm < 0` is rejected but **exactly `0`
  is accepted** (an edge-length floor of zero is legal; an angle tolerance of
  zero is not, since it would make `circularDistanceDeg(...) <= 0` an
  effectively-never-true dedup condition for any two distinct floats, which
  the code path treats as an error rather than silently degenerating).
- `deriveUsableEdges` (`transformGenerator.ts:252-284`) checks
  `Number.isFinite(deltaX) || deltaY || length` after computing them
  (`transformGenerator.ts:268-270`), then separately checks
  `normalizeRotationDeg(...) === undefined` (`transformGenerator.ts:273-276`)
  which itself is the `Number.isFinite` gate for the rotation value.
- `toGridMm` (`clipper2OffsetPolicy.ts:45-52`) checks `Number.isFinite(valueMm)`
  first, then `Number.isFinite(scaledAbsoluteValue)` after multiplying by
  scale (guards overflow to `Infinity` for extreme-magnitude inputs), then
  `Number.isSafeInteger(gridValue)` as the final gate.
- `validatePath` (`clipper2OffsetAdapter.ts:142-166`) requires every
  coordinate to be `Number.isSafeInteger` (`clipper2OffsetAdapter.ts:147-149`)
  and the Clipper2 `area(path)` result to be `Number.isFinite` and non-zero
  (`clipper2OffsetAdapter.ts:160-163`).
- `EllipseFlattening.samplePoints` explicitly checks
  `Number.isFinite(sweep) || sweep <= 0 || Number.isFinite(majorAxisLength) || majorAxisLength <= 0`
  (read as the actual `||`-chain at `ellipseFlattening.ts:30`, i.e. bails to
  `[]` if **any** of: sweep non-finite, sweep non-positive, axis-length
  non-finite, axis-length non-positive).
- `ArcFlattening.computeSampleCountForSweep` (`arcFlattening.ts:117-129`)
  checks `radius`/`sweepRad` finiteness and positivity, and separately
  checks `Number.isFinite(maxStepRad)` after the `acos` call
  (guards the case `1 - cappedSag/radius` falling outside `[-1, 1]`, which
  would make `Math.acos` return `NaN` — though `cappedSagToleranceMm = min(sag, radius)`
  algebraically keeps the argument to `acos` within `[0, 1]` for positive
  `radius`, `sag`, so this guard is defensive rather than reachable under
  well-formed positive inputs).

### Safe-integer checks

- `toGridMm`'s final `Number.isSafeInteger(gridValue)` gate
  (`clipper2OffsetPolicy.ts:52`).
- `toIntegerPath`'s per-vertex `toGridMm(...) === undefined` check
  (`clipper2OffsetAdapter.ts:120-126`).
- `validatePath`'s per-vertex `!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)`
  (`clipper2OffsetAdapter.ts:147-149`).
- `validateOutputCoordinates` (`clipper2OffsetAdapter.ts:184-197`) — same
  safe-integer check plus an explicit `maxScaledCoordinate` (`1_000_000_000`)
  magnitude bound on the **output** path returned by Clipper2, independent of
  the **input** guard (`validateCoordinateGuard`,
  `clipper2OffsetAdapter.ts:169-181`, which bounds `|input| + 2*|offset|`
  before calling Clipper2 at all).

### Rounding / truncation — the canonical grid conversion

`toGridMm` (`clipper2OffsetPolicy.ts:44-53`) implements **round half away
from zero**, deliberately, not JS's native `Math.round` (which rounds half
**toward positive infinity**, i.e. `Math.round(-0.5) === -0`, so
`Math.round(-1.5) === -1`, not `-2` — the opposite of "away from zero" for
negative halves). The actual sequence:

```
scaledAbsoluteValue = |valueMm| * 1000
roundedAbsoluteValue = Math.floor(scaledAbsoluteValue + 0.5)
gridValue = Math.sign(valueMm) * roundedAbsoluteValue
```

This is exactly `CLIPPER2_OFFSET_POLICY.rounding = 'nearest grid point, ties
away from zero'` (`clipper2OffsetPolicy.ts:13`), confirmed by the exact test
values at `tests/unit/clipper2OffsetAdapter.test.ts:76-79`
(`toGridMm(1.2345) === 1235`, `toGridMm(-1.2345) === -1235`). A Rust port
using `f64::round()` (which also rounds half away from zero, per Rust's
documented `round()` semantics) would very likely coincide numerically for
this specific step, **but the exact operation order (`abs` → `*1000` →
`+0.5` → `floor` → `* sign`) must still be reproduced literally**, because
intermediate floating-point rounding in `scaledAbsoluteValue + 0.5` is not
guaranteed bit-identical to whatever internal algorithm `f64::round()` uses,
especially near exact half-grid boundaries where the pinned test values
(`1.2344`→`1234` vs `1.2345`→`1235`, `clipper2OffsetAdapter.test.ts:76-77`)
depend on the precise binary64 representation of `1.2345 * 1000`. **Do not
substitute a "cleaner" rounding call; replicate the literal formula.**

`fromGrid` (`clipper2OffsetPolicy.ts:56-58`) is a single division:
`value / 1000`. Division by `1000` (not a power of two) is not exact in
binary64 for most integer inputs, so `fromGrid(toGridMm(x))` is not
guaranteed to equal `x`; this is expected and accounted for by the
`0.002mm` conservative allowance (see below), not a bug.

### The `0.002mm` conservative offset allowance

`conservativeOffsetMm(distanceMm) = distanceMm + CLIPPER2_OFFSET_POLICY.conservativeOffsetAllowanceMm`
(`clipper2OffsetPolicy.ts:36-38`, allowance `= 0.002`, `clipper2OffsetPolicy.ts:14`).
Documented derivation (`clipper2OffsetPolicy.ts:25-35`): a source point can
move up to `sqrt(2) * gridStepMm / 2` on quantization, the offset distance
itself can round down by another `gridStepMm / 2`, and the transformed
collision vertex can move by one more half-grid diagonal on later
canonicalization — combined bound `≈ 0.001914mm`, and `0.002mm` is chosen to
exceed that "while staying far below the configured curve sag." This is a
**derived geometry bound**, not a ranking tolerance (migration prompt §2
explicitly warns against treating it as an epsilon to be "cleaned up" or
adjusted) — it is applied exactly once, only at
`clipper2OffsetAdapter.ts:56`, and only affects how far outward the initial
collision-hull offset reaches; it never appears in any comparator, hash, or
tie-break in this cluster. The exact allowance value (`0.002`) and the
comment's derivation arithmetic are pinned by test
`tests/unit/clipper2OffsetAdapter.test.ts:82-92`, which recomputes the bound
from `CLIPPER2_OFFSET_POLICY.gridStepMm` and asserts
`conservativeOffsetAllowanceMm > maximumInwardDisplacementMm`.

### `Math.*` trig usage in transforms/flattening (must match Rust `f64` trig semantics)

- `transformGenerator.ts`: `Math.hypot` (edge length, `transformGenerator.ts:267`;
  max-radius reduction, `transformGenerator.ts:182-185`), `Math.atan2`
  (edge direction, `transformGenerator.ts:272`), `Math.asin` (angular
  tolerance formula, `transformGenerator.ts:190-193`, argument
  **explicitly clamped** to `Math.min(1, sagMm / (2 * maximumRadiusMm))`
  to avoid `asin` domain errors for `sag > 2*radius` — a case which, if
  unclamped, would produce `NaN`).
- `arcFlattening.ts`: `Math.cos`/`Math.sin` for analytic circle sampling
  (`arcFlattening.ts:36-38,70-72`), `Math.atan` for bulge sweep
  (`arcFlattening.ts:96`), `Math.hypot` for chord length
  (`arcFlattening.ts:95`), `Math.acos` for the max-step formula
  (`arcFlattening.ts:126`).
- `ellipseFlattening.ts`: `Math.cos`/`Math.sin` (`ellipseFlattening.ts:140-141`),
  `Math.hypot` (`ellipseFlattening.ts:29,118-119`), `Math.abs`
  (`ellipseFlattening.ts:30,37,122`), `Math.max`/`Math.min` throughout.
- All of the above are IEEE-754-binary64 transcendental functions. Rust's
  `f64` trig methods are also binary64 but are **not** guaranteed bit-identical
  to V8's implementations (both typically delegate to platform libm, but
  compiler/libm version differences are real). This is the single largest
  numeric-parity risk in this cluster for curve flattening and edge-direction
  math — see §15 open question on tolerance for trig-derived value mismatches.
  Prompt §8.1 explicitly calls out "`Math` function semantics used by
  transform preparation" as something to audit and reproduce deliberately,
  not something the port can assume "close enough."

### The adaptive Compact transform policy formulas (`transformGenerator.ts:158-211`)

Exactly, per current source (matches `docs/research/adaptive-compact-transform-policy.md`
verbatim, no drift found):

```
minimumEdgeLengthMm = min(
  4 * sagMm,
  0.01 * min(collisionWidthMm, collisionHeightMm)
)

angleDeduplicationToleranceDeg =
  maximumRadiusMm === 0
    ? 0.051
    : min(0.051, 2 * asin(min(1, sagMm / (2 * maximumRadiusMm))) * 180 / pi)
```

- `sagMm = input.geometrySettings.flatteningSagToleranceMm` (`transformGenerator.ts:175`).
- `collisionWidthMm`/`collisionHeightMm` from `boundsForBoundary(boundary)`
  (`transformGenerator.ts:172,213-239`) — a plain axis-aligned bounding box of
  the collision-polygon vertices, **not** the true minimal oriented bound.
- `maximumRadiusMm` is `hypot(x, y)` measured from the **collision polygon's
  local origin `(0,0)`**, i.e. the padded bounds' **lower-left corner**, not
  the polygon centroid and not a true circumcenter
  (`transformGenerator.ts:182-185`, comment confirms this is deliberate:
  "collision vertices are already local to placementReference, whose local
  coordinate is (0, 0)"). A Rust re-derivation that computes a "true" radius
  from a centroid would silently diverge from this formula. Confirmed
  invariant under moving `placementReference` in source space (test
  `transformGenerator.test.ts:334-350`) — the local frame, not the source
  frame, is what matters.
- Constants: `COMPACT_MAXIMUM_ANGLE_DEDUPLICATION_DEG = 0.051`,
  `COMPACT_EDGE_SAG_MULTIPLIER = 4`, `COMPACT_EDGE_SMALLER_DIMENSION_RATIO = 0.01`
  (`transformGenerator.ts:17-19`) — exact match to
  `docs/research/adaptive-compact-transform-policy.md`'s stated formula; **no
  contradiction found** between source and that research doc.
- Eligibility gate: `intrinsicSharedArchiveEligibility(input.settings).eligible`
  (`transformGenerator.ts:162`, defined `src/shared/irregular/executionMode.ts:15-33`).
  **Possible latent inconsistency** (not exercised by current production
  settings, see §15): `intrinsicSharedArchiveEligibility`'s `gaDisabled` check
  uses `(optimizer.gaGenerationBudget ?? 4) === 0` and
  `(optimizer.gaEvaluationBudget ?? 128) === 0`
  (`executionMode.ts:27-29`), but the schema-level defaults for these same
  fields are `DEFAULT_IRREGULAR_GA_GENERATION_BUDGET = 2` and
  `DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET = 24`
  (`domain.ts:101-102`, applied via `withDecodingDefaultKey`/`withConstructorDefault`
  at `domain.ts:371-381`). The `?? 4`/`?? 128` fallbacks in `executionMode.ts`
  therefore encode **different** numbers than the schema's actual defaults.
  Currently unreachable in practice, because every `IrregularOptimizerSettings`
  instance that reaches `intrinsicSharedArchiveEligibility` — whether built
  through schema decode or through the `defaults.ts` maker functions — always
  has these two fields explicitly populated (never `undefined`), so the `??`
  branch never fires today. Flagged prominently in §15 because it is exactly
  the kind of "TypeScript oddity that IS the spec" the migration prompt warns
  about (§2) — a Rust port must decide whether to encode the `4`/`128`
  fallback literally (byte-for-byte TS parity, including latent dead code) or
  obtain an explicit ruling that it is provably unreachable and may be
  omitted. Do not silently "fix" it to `2`/`24` without a ruling.

### `Number.isSafeInteger` / integer authority

No `BigInt` appears anywhere in this cluster's own files. The one place
`BigInt` genuinely matters for numeric correctness *reachable from* this
cluster is inside the external `clipper2-ts@2.0.1-18` dependency's
`area()`/`icArea` implementation
(`node_modules/.pnpm/clipper2-ts@2.0.1-18/.../dist/Core.js`, function
`icArea`, confirmed by direct read): it computes the shoelace sum using plain
`Number` (binary64) arithmetic on a **fast path** when every coordinate's
absolute value is below `IC_maxCoordForSafeAreaProduct`
(`≈ floor(sqrt(Number.MAX_SAFE_INTEGER) / 2)`), and falls back to an **exact
`BigInt` accumulation** otherwise, to avoid silent precision loss in the
shoelace cross-term products for near-`maxScaledCoordinate`-magnitude
polygons. This dual-path behavior is called via `area(path)` at
`clipper2OffsetAdapter.ts:160` (input-path zero-area/finite check) and via
`isPositive(offsetPath)` at `clipper2OffsetAdapter.ts:91` (output winding
check), both indirectly through Clipper2's own `area`/`isPositive` exports
(`Clipper.js:237-239,258-260`). **A Rust Clipper2 binding or reimplementation
must reproduce this exact dual-path (`f64` fast path + exact big-integer
fallback) area computation**, not just "use `f64` everywhere" or "always use
exact integers" — either simplification could change the accept/reject
decision for polygons near the coordinate-magnitude threshold, per prompt
§8.2's requirement to preserve exact signs for doubled areas.

---

## 8. Serialization and hashing

This cluster performs **no** `JSON.stringify`, no SHA-256/hash computation,
and no canonical-checkpoint encoding directly. It does, however, produce two
kinds of internal string keys used purely for local in-memory
membership/dedup (not exposed, not hashed, not persisted):

- `makePointsStore`'s `` `${x}:${y}` `` key (`geometryKernel.ts:103`) — plain
  JS template-literal `Number`→`String` coercion. This coercion uses JS's
  shortest-round-trip `Number.prototype.toString()` algorithm (e.g.
  `-0` → `"0"`, very small/large magnitudes may switch to exponential
  notation such as `"1e-7"`). This key is used **only** for `Set.has`/`Set.add`
  membership within one `flattenSourceGeometry` call; it never crosses a
  serialization or hashing boundary, so JS's specific number-to-string
  algorithm does not itself need bit-for-bit Rust reproduction — only the
  **equality semantics** it induces (does coercion make two distinct binary64
  values collide, or two visually-equal values differ) need to be preserved
  if a Rust port uses a different key encoding (e.g. exact `f64` bit-pattern
  as a hash key would be **stricter** than JS's string coercion in one
  respect — it would never collide `-0` with `0` the way JS string coercion
  does via `${-0} === "0"` — while direct `f64` equality is otherwise
  identical to JS's `===`. A Rust `(u64, u64)` bit-pattern key would need an
  explicit `-0.0 → 0.0` normalization step to match this specific JS
  collision behavior exactly).
- `` `${point.x}:${point.y}` `` in `validatePath`'s `uniquePoints`
  (`clipper2OffsetAdapter.ts:151`) — same coercion pattern, but here the
  coordinates are already-quantized **safe integers** (post `toGridMm`), so
  `-0` cannot arise from a nonzero source value; `toGridMm(-0)` can still
  produce the numeric `-0` (see §7), and `${-0}` again coerces to `"0"`,
  meaning a `-0` and `0` grid coordinate at the same position would collide
  in this key exactly as intended (harmlessly, since they represent the same
  point) — not a bug, just something to note if a Rust port picks an integer
  key type where `-0` cannot even arise (an `i64` grid value never carries a
  sign-of-zero distinction), which would make the Rust key space strictly
  simpler/safer than the JS one here.

No output of this cluster is itself a hash input in the files read for this
document. Downstream consumers (geometry cache keys, canonical layout
geometry, NFP/IFP cache keys) that **do** feed SHA-256/canonical JSON belong
to other clusters and are out of scope here, but they consume this cluster's
`CollisionGeometry`/`IrregularTransformCandidate` outputs as their inputs, so
any numeric drift originating in this cluster (grid rounding, trig results,
`-0` propagation) will surface as hash mismatches downstream. This is the
primary reason exact reproduction of §7's numeric semantics matters even
though this cluster does not hash anything itself.

---

## 9. Caches touched and the exact historical access sequence

**None.** No module in this cluster's required-reading set imports, reads, or
writes `GeometryCache`, `geometryCacheStore`, or any other cache abstraction.
Confirmed by direct reading of all seven files — none references
`GeometryCache`, `geometryCacheStore`, or a `Map`/cache type used for
cross-call memoization. `GeometryKernel.transformCollisionGeometry`
(`geometryKernel.ts:179-190`) **does** consult `geometryCache.store` via
`resolveTransformedCollisionGeometry` (`core/transformCollisionGeometryCore.ts`,
not part of this cluster's file list), but that function is a **separate**
`GeometryKernel` method, not called by anything in this cluster's seven
files. `collisionGeometryBuilder.ts` and `transformGenerator.ts` each
compute their result fresh, once, from their inputs — the natural
consequence of both being called exactly once per prepared piece
(`computeIrregularNesting.ts:389-431`), not once per placement/candidate.

One wiring detail worth noting for a future cache-focused cluster review (not
resolved here): `CollisionGeometryBuilder.Live`
(`collisionGeometryBuilder.ts:109-111`) internally does
`CollisionGeometryBuilder.Layer.pipe(Layer.provideMerge(GeometryKernel.Live))`,
and `nesting.worker.ts:397` **separately** provides `GeometryKernel.Live`
again in the same `Effect.provide` pipeline
(`nesting.worker.ts:391-398`). Because `GeometryKernel.Live` is the same
static object reference in both places, Effect's layer memoization (layers
are memoized by reference within one build) should collapse these into one
shared `GeometryKernel` instance (and therefore one shared
`GeometryCacheInMemory`), but this document does not independently verify
that memoization guarantee — flagged as a question for whichever cluster
document owns `geometryCacheStoreLive.ts`/`geometryKernel.ts`'s
`transformCollisionGeometry` path.

---

## 10. Cancellation / deadline / budget / evaluation-cap observation points

**None inside this cluster.** No function in the seven required files reads
`isCancelled`, a deadline, `IrregularNfpIfpControl`, or any budget/cap
counter. `collisionGeometryBuilder.ts`'s `buildPieces`
(`collisionGeometryBuilder.ts:104`) uses `Effect.forEach(..., { concurrency: 1 })`,
which does not itself check cancellation between items (Effect's own fiber
interruption model can still interrupt a running `Effect.forEach` externally,
but that is a property of the Effect runtime, not of anything this cluster's
code observes explicitly) — moot in any case, since `buildPieces` is not on
the production path (§1). The per-piece loop that **is** live
(`computeIrregularNesting.ts:389-431`) is a plain synchronous-per-iteration
`Effect.gen` `for...of` loop with no explicit cancellation checkpoint inside
it; any cancellation/deadline handling for the "prepare all pieces" phase as
a whole is the responsibility of whatever wraps `computeIrregularNesting`
(out of this cluster's scope — likely the worker/portfolio coordination
layer). A Rust port that wants to add a cooperative cancellation check during
piece-geometry preparation for a large piece count would be **adding** a
checkpoint that does not exist in TypeScript today; per prompt §15, this
needs to be evaluated for whether it changes accepted timing/ordering
behavior, not assumed safe by default.

---

## 11. Error paths: tagged error classes, categories, context fields, propagation

Two tagged error classes are used throughout this cluster (both
`Data.TaggedError`, defined in `services.ts`):

- `IrregularGeometryInputError` (`services.ts:42-45`): `{ operation: string; message: string }`.
  This is the **only** error type this cluster's own functions construct.
  Every failure site supplies both fields:
  - `collisionGeometryBuilder.ts`'s `failInvalidSourceGeometry`
    (`collisionGeometryBuilder.ts:240-248`): `operation: 'buildCollisionGeometry'`,
    `message: `${piece.id}: ${message}`` — always prefixes the message with
    the source piece's id.
  - `geometryKernel.ts`'s `failInvalidGeometryInput`
    (`geometryKernel.ts:260-265`): generic helper, `operation` passed by
    caller (`'offsetConvexPolygon'` at both its call sites,
    `geometryKernel.ts:236-239,251-255`).
  - `transformGenerator.ts`'s `failInvalidGeometry`
    (`transformGenerator.ts:435-440`): `operation: 'generateTransforms'` at
    every one of its four call sites
    (`transformGenerator.ts:78,83,91,99`) — the operation string is always
    `'generateTransforms'` regardless of which internal validation step
    failed; the distinguishing information lives entirely in `message`.
  - `clipper2OffsetAdapter.ts`'s `failInvalidInput`
    (`clipper2OffsetAdapter.ts:226-233`): `operation: 'offsetConvexPolygon'`
    at every call site inside this file.
  - `convexPolygonOffset.ts`'s own `failInvalidInput`
    (`convexPolygonOffset.ts:57-64`): also `operation: 'offsetConvexPolygon'`
    — note this is a **second, independently defined** function with the
    same name and same literal `operation` string as
    `clipper2OffsetAdapter.ts`'s helper; not a shared import. Harmless
    duplication, but worth flagging for the Rust module boundary (§12/§13).
- `IrregularNestingNotImplementedError` (`services.ts:34-40`):
  `{ service: string; operation: string; message: string }`. Used only by
  the `.Unimplemented` layers
  (`collisionGeometryBuilder.ts:112-118`, `geometryKernel.ts:212-227`), not
  reachable in production wiring (§1).

**Propagation:** every function in this cluster returns
`Effect.Effect<Success, IrregularGeometryInputError | IrregularNestingNotImplementedError>`
(or a subset) rather than throwing. The one place a raw JS exception is
caught and converted is `Clipper2OffsetAdapter.compute`'s `try/catch` around
`inflatePaths(...)` (`clipper2OffsetAdapter.ts:64-76`), converted via
`clipperFailureMessage` (`clipper2OffsetAdapter.ts:220-223`):
`error instanceof Error ? `Clipper2 offset failed: ${error.message}` : 'Clipper2 offset failed with a non-error exception.'`.
This is the **only** boundary in this cluster where an uncontrolled external
exception (from the `clipper2-ts` npm dependency) is caught and normalized —
directly analogous to what a Rust port must do at its own Clipper2
binding/panic boundary (prompt §16's "contain every Rust panic" applies
squarely to whatever replaces this `try/catch`).

**Mapping to the external `AppErrorCode` protocol** (per migration prompt
§16's table): both `IrregularGeometryInputError` →
`irregular_geometry_invalid` (with `operation` context) and
`IrregularNestingNotImplementedError` → `not_implemented` (with `service`
and `operation` context) are pre-specified in the prompt's table and this
cluster's usage is fully consistent with those categories — no ambiguity
found here.

No error class specific to arc/ellipse flattening exists — malformed
flattening inputs (e.g. a degenerate bulge) degrade silently to a straight
chord (`arcFlattening.ts:60-63`) or an empty point array
(`ellipseFlattening.ts:30-32`) rather than raising an error; any resulting
invalid geometry is caught **later**, by `ConvexPolygonValidation.validateStrictBoundary`
inside `normalizeHull`/`transformGenerator.ts`'s validation calls, not by the
flattening functions themselves.

---

## 12. JS-specific semantics hazards for a Rust port

- **Stable sort reliance** — `transformGenerator.ts:299,315` (two separate
  `Array.prototype.sort` calls with different comparators, see §5/§6). Use
  `Vec::sort_by` (stable) in Rust, never `sort_unstable_by`.
- **Template-literal number coercion as a dedup key** —
  `geometryKernel.ts:103`, `clipper2OffsetAdapter.ts:151` (see §8). JS
  `${n}` uses the shortest-round-trip `Number.prototype.toString()`
  algorithm, including collapsing `-0` to `"0"`. A Rust port must decide its
  own key representation deliberately and verify it induces the same
  equivalence classes, not assume `format!("{}", f)` matches.
- **Signed zero propagation through `toGridMm`/`fromGrid`** — see §7. Rust
  `f64` sign-of-zero rules for `*`/`/` match IEEE-754 identically to JS, so
  literal translation of the formula is safe; the hazard is only in code that
  *stringifies* the result afterward (out of this cluster, but downstream).
- **`Array.prototype.some` used for O(n) membership scans inside a loop
  (O(n²) overall)** — `appendDistinctChoice` (`transformGenerator.ts:391-399`),
  `validatePath`'s per-file dedup patterns. Purely a performance
  characteristic, not a semantic hazard, but worth noting since the migration
  prompt (§19) treats performance as a promotion gate — a Rust rewrite could
  legitimately use a faster structure here **as long as observable order and
  ties are identical**; the O(n²) pattern itself is not part of the "spec,"
  only its outcome is.
- **Effect Schema re-decoding on every call** — `transformGenerator.ts:244-249`
  (`decodeInput`) and `geometryKernel.ts:246-258` (`decodeOffsetConvexPolygonInput`)
  re-validate/re-materialize their entire structured input via
  `Schema.decodeUnknownExit` on **every** `generateTransforms`/`offsetConvexPolygon`
  call, not just at the outer request boundary. This is idiomatic
  Effect-Schema defense-in-depth, not JS-specific per se, but it means the
  TypeScript implementation performs real, repeated, per-piece validation
  work that a Rust port replacing "Effect Schema decode" with "trust the
  already-typed domain struct" would skip — functionally equivalent for
  well-typed Rust callers, but worth an explicit decision (documented, not
  silently dropped) since prompt §7 requires "revalidate safety-critical
  invariants in Rust at the trust boundary," and this cluster currently
  revalidates **inside** the algorithm, not just at the boundary.
- **Two structurally-identical `rotateToStableStart` implementations** —
  `clipper2OffsetAdapter.ts:205-217` (over `Path64`/integers) and
  `convexPolygonOffset.ts:42-54` (over `IrregularPoint`/floats). Both use
  strict `<` tie rules (first-index wins on exact tie). Safe to unify into
  one generic Rust helper as long as the tie rule and traversal order are
  identical (confirmed identical by direct comparison).
- **Two independently-defined `failInvalidInput` closures with the same
  `operation` string** — `clipper2OffsetAdapter.ts:226-233` and
  `convexPolygonOffset.ts:57-64`. Not a hazard per se (both produce
  identical error shapes), but a naive Rust "one function per file" mapping
  would create genuinely duplicate code; fine to consolidate since output is
  identical either way.
- **No UTF-16/locale string comparison anywhere in this cluster** — none of
  these seven files compare strings for ordering (`PieceId`/`sourceId` are
  only compared for **equality** via `Set.has`, never sorted). This
  particular hazard class (prompt §9/§12) does not apply inside this
  cluster's own logic.
- **Object identity vs. structural equality in tests** — several tests in
  this cluster's test files (e.g.
  `tests/unit/clipper2OffsetAdapter.test.ts:100-107`) use `toEqual` (deep
  structural equality) against freshly constructed `IrregularPolygon`/
  `IrregularPoint` instances, not identity checks — consistent with these
  being plain value classes; no hidden reference-identity semantics to
  replicate.

---

## 13. Parallelism assessment

### Safe Rayon candidates (pure, independent, stable-index-reducible)

- **Per-piece collision geometry build + transform generation**, exactly
  matching prompt §14.1's first two bullets ("independent collision-geometry
  preparation by stable piece index," "independent transform materialization
  by stable piece and transform index"). The current live loop
  (`computeIrregularNesting.ts:389-431`) computes, for each prepared piece
  `i` in `sortedPieces` order: `collisionGeometry_i = buildPiece(source_i, request.padding)`
  then `transforms_i = generateTransforms(collisionGeometry_i, ...)`. Both
  calls are **pure functions of piece-local inputs plus globally-shared,
  read-only settings** — no piece's computation reads or mutates any other
  piece's intermediate state. This is confirmed directly by this cluster's
  own analysis (§4: no cross-call mutable state; §9: no shared cache touched
  by these functions). The **only** cross-piece shared state in the current
  loop is:
  - `diagnostics: CollisionGeometryDiagnostic[]` (`computeIrregularNesting.ts:383,430`),
    appended to sequentially, in `sortedPieces` order.
  - `preparedPieces: IrregularPreparedPiece[]` (`computeIrregularNesting.ts:382,415-429`),
    pushed to sequentially, in `sortedPieces` order.

  A safe Rayon translation must: (1) assign each piece its stable ordinal
  from `sortedPieces` before spawning any work (prompt §14.3 step 1-2); (2)
  compute `collisionGeometry_i`/`transforms_i` in parallel, writing results
  into pre-sized slots indexed by ordinal, not by completion order; (3)
  reconstruct `preparedPieces` and concatenate `diagnostics` by walking
  ordinals `0..n` **in order**, never by whichever thread finished first
  (prompt §14.3 steps 4-6). Given `buildPiece`'s internal use of the external
  `clipper2-ts` library (`inflatePaths`), the chosen Rust Clipper2
  binding/port must itself be safe for concurrent, independent invocation
  from multiple threads (no shared mutable global state inside the geometry
  library) — this needs explicit verification once a specific Rust Clipper2
  strategy is chosen; it is a property of the **binding**, not of this
  cluster's TS code, but the parallelization plan depends on it.
- **Curve flattening within one piece** (`ArcFlattening`/`EllipseFlattening`
  calls across a piece's segments, `geometryKernel.ts:119-161`) is also pure
  per-segment **except** for the shared `pointsStore`/`sampledSourceCurves`
  mutable accumulators (§4) — parallelizing segment flattening within one
  piece would require either (a) computing each segment's point list
  independently in parallel then serially merging into the accumulator in
  original segment order (preserving both the ordering and the exact-key
  global dedup semantics), or (b) leaving this loop serial (it is typically
  small — tens of segments per piece — so the benefit is likely marginal
  compared to piece-level parallelism above). Flagged as a secondary,
  lower-priority candidate.

### Not safe to parallelize as an uncontrolled cohort

- Nothing in this cluster involves completion-order-sensitive selection,
  archive admission, checkpoint publication, or scheduler chronology (those
  concerns belong to later clusters). This cluster's only "unsafe if raced"
  behavior is the **order-sensitivity of `diagnostics`/`preparedPieces`
  concatenation** described above — not unsafe to parallelize, just unsafe to
  **reduce by completion order** instead of by stable ordinal (prompt §14.3
  makes this exact distinction).
- `CollisionGeometryBuilder.buildPieces`'s existing
  `Effect.forEach(..., { concurrency: 1 })` (`collisionGeometryBuilder.ts:104`)
  is itself evidence that even the TypeScript codebase treats "many pieces,
  independent geometry" as conceptually forEach-shaped — but it deliberately
  pins concurrency to `1` (serial), so it provides no evidence about
  behavior under real concurrency; it does not need to be preserved as
  "concurrency: 1" in Rust (it is not on the production path, §1), but its
  shape is a useful sanity check that per-piece independence was already
  assumed safe by the original TS authors.

---

## 14. Tests and gates covering this cluster

Direct unit tests (confirmed by reading each file's imports/describe blocks):

- `tests/unit/collisionGeometryBuilder.test.ts` — `CollisionGeometryBuilder.buildPiece`/`buildPieces`,
  full-circle closing-point dedup, exact padded-offset numeric examples
  (verified two independent worked examples against `computeCollisionOffsetMm`
  + `conservativeOffsetMm` by hand in this investigation — both match exactly),
  diagnostics propagation from `piece.warnings`, open-path rejection,
  `Unimplemented` isolation.
- `tests/unit/transformGenerator.test.ts` — the most extensive test file for
  this cluster: orthogonal baseline, mirror-cap interaction, edge-vs-configured
  priority, transform-profile presets (`makeFastIdentityIrregularOptimizerSettings`,
  `makeOrthogonalIrregularOptimizerSettings`, `makeDerivedOrientationIrregularOptimizerSettings`),
  mirrored edge-angle horizontal-alignment proof (via
  `TransformCollisionGeometry.compute`), adaptive Compact scale-invariance
  across `0.1x/1x/10x` (`transformGenerator.test.ts:284-313`), large-radius
  distinctness (`transformGenerator.test.ts:315-332`), placement-reference
  translation invariance (`transformGenerator.test.ts:334-350`), longer-edge
  representative selection under cap pressure
  (`transformGenerator.test.ts:375-410`), circular zero-seam dedup
  (`transformGenerator.test.ts:412-422`), periodic configured-angle
  normalization (`transformGenerator.test.ts:424-434`), cyclic-rotation
  input-order invariance (`transformGenerator.test.ts:443-448`), invalid
  polygon rejection (`transformGenerator.test.ts:450-456`).
- `tests/unit/clipper2OffsetAdapter.test.ts` — policy tuple pinning
  (`CLIPPER2_OFFSET_POLICY` full-object `toEqual`), `toGridMm`/`fromGrid`
  rounding pin, conservative-allowance bound proof, CCW normalization for
  both CW and CCW inputs (exercises `convexPolygonOffset.ts`'s
  `restoreInputWinding` CW branch, which is otherwise **not** exercised by
  the production `collisionGeometryBuilder.ts` path since `ConvexHull.compute`
  always yields CCW input — see §1/§15), miter-join sharp-corner exactness,
  headroom/coordinate-guard rejection, quantization-collapse rejection,
  non-convex-input rejection.
- `tests/unit/irregularGeometryKernel.test.ts` — `GeometryKernel` end-to-end
  (flatten → hull → offset → transform), including near-ULP arbitrary-angle
  canonicalization and degenerate-hull rejection; indirectly exercises this
  cluster through the kernel's composed pipeline.
- `tests/unit/dxfSourceFlattening.test.ts` — the **only** test exercising
  `ArcFlattening`/`EllipseFlattening` sampling density behavior, and only
  indirectly (through `GeometryKernel.flattenSourceGeometry`, real DXF import
  of a bulge polyline and an ellipse). **No test directly imports or unit-tests
  `ArcFlattening`/`EllipseFlattening` by name** (confirmed:
  `grep -rn "ArcFlattening\|EllipseFlattening" tests` → no hits at all). No
  test exercises extreme-radius arcs, the `ArcFlattening` unbounded-sample-count
  path (§15), or `EllipseFlattening`'s empty-array degenerate return (§15).
- `tests/unit/geometryBackendParity.test.ts` — exercises `CollisionGeometryBuilder.buildPiece`
  against real DXF fixture files as part of a **different** parity concept
  (NFP construction-algorithm backend comparison, unrelated to the TS/Rust
  backend split this migration introduces) — collision-prep output is an
  input fixture to that test, not its subject.
- `tests/unit/irregularInfrastructure.test.ts` — layer wiring smoke test for
  `CollisionGeometryBuilder`.

Indirect coverage through end-to-end/golden fixtures (not read in full for
this document, listed for completeness):
`tests/unit/irregularTriangleCompactGolden.test.ts`,
`tests/unit/irregularSeventeenShapesCompactGolden.test.ts`,
`tests/unit/irregularPortfolio.test.ts`,
`tests/unit/irregularWorkerCompute.test.ts`,
`tests/unit/intrinsicCapacityIntegration.test.ts`,
`tests/unit/intrinsicSqueezeDisruptSeparate.test.ts`,
`tests/unit/irregularBenchmark.test.ts` — all exercise the full Compact
pipeline, which necessarily routes through this cluster's code on every run.

Production gates (`package.json`) that transitively depend on this cluster
producing byte-identical output:

- `pnpm gate:mixed61-compact` (`package.json:32`) — asserts an exact
  canonical SHA-256 (`ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b`,
  matching the migration prompt §18.6's stated "fitted canonical identity"),
  a maximum area (`391606mm2`, consistent with the prompt's `391605.850174mm2`
  ceiling), and `--maximum-canonical-cavities 0`. Any drift in this cluster's
  trig, rounding, or transform ordering would change placement geometry and
  break this gate.
- `pnpm gate:compact-nine-baselines` (`package.json:33`,
  `scripts/irregular-compact-nine-baselines.ts`, not read in full).
- `pnpm gate:capacity` / `pnpm gate:capacity:production` (`package.json:34-35`).
- Numerous probe/diagnostic scripts under `scripts/irregular-*.ts` import
  `clipper2OffsetPolicy.ts`'s grid conversion helpers directly (listed in
  §1's purpose note), confirming this cluster's numeric primitives are
  exercised across most of the diagnostic tooling, not just the production
  algorithm path.

---

## 15. Open questions and ambiguities

1. **`knowledge/` directory does not exist in this checkout.** The migration
   prompt's §5 "authoritative implementation map" instructs starting from
   `knowledge/INDEX.md` and specifically names
   `knowledge/adaptive-compact-transform-policy.md`. No `knowledge/` directory
   exists anywhere under the repo root (`find . -iname "knowledge*"` from
   root returns nothing). This document used
   `docs/research/adaptive-compact-transform-policy.md` per this task's
   explicit instruction, and found it consistent with current source (no
   drift). The orchestrator should resolve whether `knowledge/` was moved,
   renamed to `docs/research/`+`docs/planning/`, or never existed on this
   branch, before other Stage-0 characterization work assumes it is
   reachable.
2. **`intrinsicSharedArchiveEligibility`'s nullish-fallback constants (`4`,
   `128`) do not match the schema defaults (`2`, `24`) for
   `gaGenerationBudget`/`gaEvaluationBudget`** (`src/shared/irregular/executionMode.ts:27-29`
   vs. `src/shared/irregular/domain.ts:101-102,371-381`). Currently
   unreachable dead code under every construction path this investigation
   traced (schema decode always fills the field; every `defaults.ts` maker
   sets it explicitly). Needs an explicit ruling: encode literally
   (byte-for-byte TS parity including latent dead code) or get confirmation
   it is provably unreachable and may be omitted from the Rust port. This
   directly gates whether the **adaptive Compact transform policy** (this
   cluster's centerpiece) ever activates, so it is not a peripheral detail.
3. **`EllipseFlattening.samplePoints` can return a completely empty array**
   (`ellipseFlattening.ts:30-32`) on degenerate input (non-positive/non-finite
   sweep or major-axis length), discarding even the segment's start point,
   whereas `ArcFlattening.samplePoints`/`sampleBulgePoints` always return at
   least the two imported endpoints. No test exercises this branch. Is this
   asymmetry intentional (ellipses with degenerate parameters should
   contribute nothing) or an oversight that happens to never fire because
   upstream DXF import already guarantees non-degenerate ellipse parameters?
   Needs a source-truth ruling before a Rust port decides whether to
   "helpfully" add a fallback endpoint (which would be an unauthorized
   behavior change) or reproduce the empty-array behavior exactly (the
   semantics-preserving default per prompt §2).
4. **`ArcFlattening.computeSampleCountForSweep` has no explicit upper bound**
   on the number of samples it can produce (unlike `EllipseFlattening`, which
   caps at `MAX_RECURSION_DEPTH = 20` / `MAX_SAMPLE_POINTS = 1_000_000`,
   `ellipseFlattening.ts:8-9`). For a large radius relative to a fixed
   `sagToleranceMm`, `sampleCount` grows roughly with `sqrt(radius)` and is
   otherwise unbounded (`arcFlattening.ts:117-129`). No test exercises an
   extreme-radius arc. Is an unbounded sample count for pathological/malformed
   DXF input accepted current behavior (to be faithfully reproduced, however
   slow or memory-heavy), or should this be raised as a latent resource-
   exhaustion risk to the repository owners before porting? The migration
   prompt forbids "cleaning up" observable behavior unilaterally, so this
   needs an explicit ruling rather than a unilateral Rust-side cap.
5. **Exact reproduction of `clipper2-ts@2.0.1-18`'s `inflatePaths`
   (Miter join, Polygon end type) geometry.** This cluster's read scope
   stopped at confirming the call parameters
   (`clipper2OffsetAdapter.ts:66-73`) and the dual-path `area()`
   f64-fast-path / BigInt-exact-fallback behavior (§7). It did **not**
   trace `inflatePaths`'s full offsetting algorithm (arc/miter join
   geometry construction, `Offset.js`, not read). Whichever Rust Clipper2
   strategy is eventually chosen (native binding vs. faithful port) needs
   its own dedicated differential-testing pass against `clipper2-ts@2.0.1-18`
   specifically (pinned version), per migration prompt §8.3 — this is
   flagged here as a **major** open item for the geometry/Clipper2-focused
   Rust work, not resolved by this document.
6. **Effect-Schema re-decoding inside the algorithm (not just at the outer
   trust boundary)** — `transformGenerator.ts:244-249` and
   `geometryKernel.ts:246-258` re-validate structured input on every call.
   Should the Rust port replicate this as "revalidate on every call" (safer,
   matches literal TS behavior, but adds per-piece overhead a coarse-grained
   Rust boundary might not need) or treat it as boundary-only validation that
   the coarse N-API entry point already subsumes? This is a design decision
   for Stage 1 (coarse boundary design), not something this document can
   resolve alone, but it is squarely raised by this cluster's code.
7. **Whether `GeometryKernel.Live`'s layer-memoization sharing (§9) actually
   produces one shared cache instance in the current worker wiring**
   (`nesting.worker.ts:391-398`) was asserted from Effect's documented
   layer-memoization-by-reference behavior, not independently verified by
   a targeted test or runtime trace in this investigation. Recommended as a
   quick verification step for whichever cluster document owns
   `geometryCacheStoreLive.ts`.

No contradictions were found between this cluster's source code and the
migration prompt's own summary of "exact numeric semantics" or the adaptive
Compact transform policy's stated formula — the `docs/research/adaptive-compact-transform-policy.md`
description matches `transformGenerator.ts` exactly, including the specific
constants `0.051`, `4`, `0.01`. The material discrepancies found are internal
to the source tree itself (items 2-4 above), not between source and the
migration prompt.
