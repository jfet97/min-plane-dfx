/**
 * Differential-vector generator for
 * `crates/irregular-nesting-native/src/archive/reconstruction.rs`.
 *
 * Imports the REAL production TS entry points from
 * `src/workers/algorithm/irregular/intrinsicReconstructionPortfolio.ts` --
 *   `runIntrinsicReconstructionPortfolio`, `buildIntrinsicReconstructionSpecs`,
 *   `intrinsicReconstructionSpecMatchesFamily`, `buildCanonicalEndpointOrders`,
 *   `retainIntrinsicReconstructionArchive`, `intrinsicReconstructionEffectiveOrderKey`,
 *   `intrinsicPreparedPieceClassKey`
 * -- and evaluates the Effect-returning entry point through the REAL Effect
 * service layer stack (`GeometryKernel.Live`, `GeometrySettings.Live`,
 * `NfpIfpServiceLive` -- the same layer shape `dump-strict-decoder.ts`/
 * `dump-capacity-search.ts` already establish), driven with
 * `Effect.runSyncExit`.
 *
 * Real mixed61 fixture-piece convex hulls (`computeConvexHull` over
 * `tests/fixtures/irregularSheetInvariance/mixed61-request.json` segment
 * endpoints) plus small hand-built axis-aligned rectangles form every
 * prepared piece's collision polygon, mirroring `dump-capacity-search.ts`'s
 * own technique.
 *
 * Determinism: `runIntrinsicReconstructionPortfolio` itself has no injectable
 * `timingNow` seam (it calls the real global `performance.now()` directly and
 * does not thread a `timingNow` into its own `constructIntrinsicStrictState`
 * calls either -- both fall back to the same real global clock in
 * production, see the Rust port's own top-doc). Deadline cases therefore use
 * `maximumTotalRuntimeMs: 0` (any nonnegative elapsed wall-clock time trips
 * `remainingTotalMs <= 0` on the very first spec, deterministically, exactly
 * as `tests/unit/intrinsicReconstructionPortfolio.test.ts` itself does);
 * evaluation-cap cases use tiny `maximumCandidateEvaluationsPerDecode`/
 * `maximumTotalCandidateEvaluations` values, which are wall-clock-independent.
 * `runtimeMs` fields are recorded for informational completeness but are
 * **not** part of the Rust port's parity contract (diagnostic-only, per
 * characterization §7.5) -- the Rust differential test must not assert on
 * them.
 *
 * Sections (each independently contributes to the >= 300 total asserted
 * below):
 *   A. `buildCanonicalEndpointOrders` pure sweep across small piece/placement
 *      configurations (including a piece deliberately left out of the placed
 *      set, exercising the "missing position -> id `localeCompare` fallback"
 *      branch).
 *   B. `buildIntrinsicReconstructionSpecs` + `intrinsicReconstructionSpecMatchesFamily`
 *      sweep: the canonical 11-entry spec order plus per-family filtered
 *      counts, across several piece-set/endpoint configurations.
 *   C. `intrinsicReconstructionEffectiveOrderKey`/`intrinsicPreparedPieceClassKey`
 *      pure sweep: order-independence of interchangeable geometry,
 *      order-sensitivity of distinct geometry, transform-set variations.
 *   D. `retainIntrinsicReconstructionArchive` pure sweep: capacity bounds,
 *      canonical-hash dedup, the two-literal `protectedSeeds` role filter
 *      (confirming `'settled-protected'` is *not* privileged).
 *   E. Full `runIntrinsicReconstructionPortfolio` end-to-end cases across
 *      small real mixed61-hull and rectangle piece sets (2-4 pieces), each
 *      seeded from a REAL completed sheetless decode
 *      (`constructIntrinsicStrictState` + `measureIntrinsicSheetlessCompletedLayout`),
 *      crossed with every `roleFamily` value and both the production-shaped
 *      cap (`15_000`ms / `12_000` evaluations) and generous/unbounded caps --
 *      recording every run's full field set (status, `duplicateOf`,
 *      `pieceIds`, `effectiveOrderKey`, placements, step trace, gap-fill
 *      evidence, metrics) plus the portfolio-level archive/winner/counters.
 *   F. Deliberately-colliding `orderOwners` cases: piece sets pre-sorted so
 *      an endpoint-derived order exactly reproduces `reversed-priority`'s
 *      (or `open-pocket-first`'s) piece sequence, forcing genuine
 *      `'duplicate-order'` runs (the orderOwners "first attempt claims the
 *      slot regardless of its own outcome" rule, characterization §5.2).
 *   G. Deadline cases (`maximumTotalRuntimeMs: 0`) and evaluation-cap cases
 *      (`maximumCandidateEvaluationsPerDecode`/`maximumTotalCandidateEvaluations`
 *      set to `1`), each across several piece sets and role families.
 *   H. Cancellation propagation: a `control.checkpoint` that always fails
 *      with `reason: 'cancelled'`, recording the propagated failure shape.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-reconstruction.ts
 *
 * Every recorded case carries its own `seed` (role, canonical hash,
 * placements, step trace, metrics) alongside `seedRole` -- the Rust harness
 * reconstructs the exact seed TS actually ran with (not a recomputed one),
 * since Section F's seeds are hand-placed (`realPlace`), not decoded
 * (`realSeedFrom`), and only the recorded seed is guaranteed to match.
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/reconstruction.json
 */
import { Cause, Effect } from 'effect'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { computeConvexHull } from '../../src/workers/irregular/core/convexHullCore.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { IrregularNfpIfpControlAbortError } from '../../src/workers/irregular/services.js'
import {
  constructIntrinsicStrictState,
  measureIntrinsicSheetlessCompletedLayout,
  type IntrinsicStrictCandidateMode,
  type IntrinsicStrictCompletedMetrics,
  type IntrinsicStrictStepTrace
} from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import {
  buildCanonicalEndpointOrders,
  buildIntrinsicReconstructionSpecs,
  intrinsicPreparedPieceClassKey,
  intrinsicReconstructionEffectiveOrderKey,
  intrinsicReconstructionSpecMatchesFamily,
  retainIntrinsicReconstructionArchive,
  runIntrinsicReconstructionPortfolio,
  INTRINSIC_RECONSTRUCTION_ARCHIVE_CAPACITY,
  INTRINSIC_RECONSTRUCTION_ROLES,
  type IntrinsicReconstructionPortfolioResult,
  type IntrinsicReconstructionRole,
  type IntrinsicReconstructionRoleFamily,
  type IntrinsicReconstructionRun,
  type IntrinsicReconstructionSeed
} from '../../src/workers/algorithm/irregular/intrinsicReconstructionPortfolio.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const VECTORS_DIR = join(REPO_ROOT, 'crates', 'irregular-nesting-native', 'tests', 'vectors')
const MIXED61_FIXTURE_PATH = join(
  REPO_ROOT,
  'tests/fixtures/irregularSheetInvariance/mixed61-request.json'
)

if (INTRINSIC_RECONSTRUCTION_ROLES.length !== 14) {
  throw new Error(
    `Expected 14 INTRINSIC_RECONSTRUCTION_ROLES entries, got ${INTRINSIC_RECONSTRUCTION_ROLES.length}.`
  )
}

function generatingCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim()
}

// ---------------------------------------------------------------------------
// f64 -> exact big-endian IEEE-754 bit-pattern hex string.
// ---------------------------------------------------------------------------
function f64Bits(value: number): string {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setFloat64(0, value, false)
  let hex = '0x'
  for (let i = 0; i < 8; i++) {
    hex += view.getUint8(i).toString(16).padStart(2, '0')
  }
  return hex
}
function encodeOptionalNum(value: number | undefined): string | null {
  return value === undefined ? null : f64Bits(value)
}
function failureDetail(cause: Cause.Cause<unknown>): {
  readonly tag: string
  readonly reason?: string
  readonly message?: string
} {
  const found = Cause.findFail(cause) as {
    readonly _tag: string
    readonly success?: { readonly _tag?: string; readonly error?: unknown }
  }
  if (found._tag !== 'Success' || found.success === undefined) {
    throw new Error(`failureDetail: expected a Fail reason in cause, got ${JSON.stringify(found)}`)
  }
  const error = found.success.error as
    | { readonly _tag?: string; readonly reason?: string; readonly message?: string }
    | undefined
  return {
    tag: error?._tag ?? 'unknown',
    ...(error?.reason === undefined ? {} : { reason: error.reason }),
    ...(error?.message === undefined ? {} : { message: error.message })
  }
}

// ---------------------------------------------------------------------------
// Domain-object construction helpers (mirror `dump-capacity-search.ts`'s own
// identically-named helpers).
// ---------------------------------------------------------------------------
function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}
function boundsOf(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  return new IrregularBounds({
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y))
  })
}
function sourcePiece(id: string): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`source-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width: 1, height: 1 }),
    geometry: new DxfGeometrySummary({ entityType: 'PRESET_SHAPE', closed: true, segments: [] }),
    warnings: []
  })
}
function transformCandidates(count: number): IrregularTransformCandidate[] {
  const rotations = [0, 90, 180, 270]
  const out: IrregularTransformCandidate[] = []
  for (let i = 0; i < count; i++) {
    out.push(
      new IrregularTransformCandidate({
        index: i,
        rotationDeg: rotations[i % rotations.length] ?? 0,
        mirrored: i % 3 === 2,
        reason: 'configured'
      })
    )
  }
  return out
}
function preparedPiece(
  id: string,
  points: ReadonlyArray<IrregularPoint>,
  transformCount = 1
): IrregularPreparedPiece {
  const shape = new IrregularPolygon({ points })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(id),
    source: sourcePiece(id),
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: PieceId.make(id),
      sourceBounds: boundsOf(points),
      sampledPoints: points,
      convexHull: shape,
      collisionPolygon: shape,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms: transformCandidates(transformCount)
  })
}
function rectanglePoints(width: number, height: number): IrregularPoint[] {
  return [point(0, 0), point(width, 0), point(width, height), point(0, height)]
}

// ---------------------------------------------------------------------------
// Real mixed61 fixture-piece hull rings.
// ---------------------------------------------------------------------------
interface FixtureLineSegment {
  readonly kind: string
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}
interface FixturePiece {
  readonly label: string
  readonly geometry: { readonly segments: ReadonlyArray<FixtureLineSegment> }
}
interface Mixed61Fixture {
  readonly sourcePieces: ReadonlyArray<FixturePiece>
}
const mixed61Fixture: Mixed61Fixture = JSON.parse(readFileSync(MIXED61_FIXTURE_PATH, 'utf8'))
if (mixed61Fixture.sourcePieces.length !== 61) {
  throw new Error(
    `Expected 61 source pieces in the mixed61 fixture, got ${mixed61Fixture.sourcePieces.length}.`
  )
}
const fixtureHullCache = new Map<number, IrregularPoint[]>()
function fixtureHullRing(index: number): IrregularPoint[] {
  const wrapped = ((index % 61) + 61) % 61
  const cached = fixtureHullCache.get(wrapped)
  if (cached !== undefined) return cached
  const piece = mixed61Fixture.sourcePieces[wrapped]
  if (piece === undefined) throw new Error('fixture piece index out of range')
  const rawPoints = piece.geometry.segments.map((segment) => point(segment.x1, segment.y1))
  const hull = computeConvexHull(rawPoints)
  const hullPoints = hull.points.map((p) => point(p.x, p.y))
  if (hullPoints.length < 3) {
    throw new Error(`fixture piece ${wrapped} produced a degenerate hull`)
  }
  fixtureHullCache.set(wrapped, hullPoints)
  return hullPoints
}

// ---------------------------------------------------------------------------
// Effect layer runners.
// ---------------------------------------------------------------------------
function runConstruct(
  input: Parameters<typeof constructIntrinsicStrictState>[0]
) {
  return Effect.runSyncExit(
    constructIntrinsicStrictState(input).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
}
function runPortfolio(
  input: Parameters<typeof runIntrinsicReconstructionPortfolio>[0]
) {
  return Effect.runSyncExit(
    runIntrinsicReconstructionPortfolio(input).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

// ---------------------------------------------------------------------------
// Encoding helpers.
// ---------------------------------------------------------------------------
function candidateModeLabel(mode: IntrinsicStrictCandidateMode): string {
  return typeof mode === 'string' ? mode : mode.kind
}
function encodePlacement(placement: IrregularPlacement) {
  return {
    pieceId: placement.sourcePieceId,
    translateX: f64Bits(placement.transform.translateX),
    translateY: f64Bits(placement.transform.translateY),
    rotationDeg: f64Bits(placement.transform.rotationDeg),
    mirrored: placement.transform.mirrored
  }
}
function encodeLocalScore(score: IntrinsicStrictStepTrace['selectedScore']) {
  if (score === undefined) return null
  return {
    maximumSideMm: f64Bits(score.maximumSideMm),
    envelopeAreaMm2: f64Bits(score.envelopeAreaMm2),
    envelopeSpanMm: f64Bits(score.envelopeSpanMm),
    sharedBoundaryLengthMm: f64Bits(score.sharedBoundaryLengthMm),
    canonicalCombinedGeometryKey: score.canonicalCombinedGeometryKey
  }
}
function encodeStepTrace(stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>) {
  return stepTrace.map((entry) => ({
    pieceId: entry.pieceId,
    candidateCount: f64Bits(entry.candidateCount),
    transformFamilyCount: f64Bits(entry.transformFamilyCount),
    selectedTransformFamily: entry.selectedTransformFamily ?? null,
    selectedScore: encodeLocalScore(entry.selectedScore)
  }))
}
function encodeGapFillEvidence(evidence: IntrinsicReconstructionRun['gapFillEvidence']) {
  return evidence.map((entry) => ({
    pieceId: entry.pieceId,
    regionKey: entry.regionKey,
    regionAreaBeforeMm2: f64Bits(entry.regionAreaBeforeMm2),
    regionAreaAfterMm2: f64Bits(entry.regionAreaAfterMm2),
    envelopeMaximumSideDeltaMm: f64Bits(entry.envelopeMaximumSideDeltaMm),
    envelopeAreaDeltaMm2: f64Bits(entry.envelopeAreaDeltaMm2),
    sharedBoundaryLengthMm: f64Bits(entry.sharedBoundaryLengthMm),
    nonInert: entry.nonInert
  }))
}
function encodeMetrics(metrics: IntrinsicStrictCompletedMetrics | undefined) {
  if (metrics === undefined) return null
  return {
    envelopeMaximumSideMm: f64Bits(metrics.envelopeMaximumSideMm),
    envelopeAreaMm2: f64Bits(metrics.envelopeAreaMm2),
    envelopeSpanMm: f64Bits(metrics.envelopeSpanMm),
    enclosedCavityCount: f64Bits(metrics.enclosedCavityCount),
    totalEnclosedCavityAreaMm2: f64Bits(metrics.totalEnclosedCavityAreaMm2),
    largestOccupiedHullGapRatio: f64Bits(metrics.largestOccupiedHullGapRatio),
    isolatedPieceCount: f64Bits(metrics.isolatedPieceCount),
    positiveContactComponentCount: f64Bits(metrics.positiveContactComponentCount),
    largestPositiveContactComponentSize: f64Bits(metrics.largestPositiveContactComponentSize),
    largestPositiveContactComponentRatio: f64Bits(metrics.largestPositiveContactComponentRatio),
    occupiedAreaOutsideLargestContactComponentMm2: f64Bits(
      metrics.occupiedAreaOutsideLargestContactComponentMm2
    ),
    occupiedHullWasteRatio: f64Bits(metrics.occupiedHullWasteRatio),
    totalStructuralContacts: f64Bits(metrics.totalStructuralContacts),
    dominantStructuralContacts: f64Bits(metrics.dominantStructuralContacts),
    contactUnits: f64Bits(metrics.contactUnits),
    sharedBoundaryLengthMm: f64Bits(metrics.sharedBoundaryLengthMm),
    canonicalGeometryHash: metrics.canonicalGeometryHash
  }
}
/**
 * Encodes one seed's `placedCollisionGeometries` entry as the minimal
 * placement fields needed for the Rust differential harness to reconstruct
 * an equivalent `IrregularPlacedPiece` from the case's already-recorded
 * `pieces` array (pieceId + the placement transform) -- deliberately
 * narrower than a full geometry round-trip since every portfolio-case piece
 * carries exactly one transform candidate (`preparedPiece`'s
 * `transformCount = 1` default), so the piece's own `transforms[0]` plus
 * this placement transform fully determines the placed geometry.
 */
function encodeSeedPlacement(p: IrregularPlacedPiece) {
  return {
    pieceId: (p.placement.pieceId ?? p.placement.sourcePieceId) as string,
    translateX: f64Bits(p.placement.transform.translateX),
    translateY: f64Bits(p.placement.transform.translateY),
    rotationDeg: f64Bits(p.placement.transform.rotationDeg),
    mirrored: p.placement.transform.mirrored
  }
}
/**
 * Encodes the full baseline seed actually consumed by
 * `runIntrinsicReconstructionPortfolio` for this case -- **not** just
 * `seedRole` -- so the Rust harness reconstructs the byte-identical seed
 * that produced this case's recorded outcome rather than re-deriving a
 * (potentially different) seed of its own. Load-bearing distinction: not
 * every case's seed comes from a real decode (`realSeedFrom`) --
 * Section F's `DUPLICATE_ORDER_BATTERY` seeds are hand-placed via
 * `realPlace` at deliberately chosen (non-decoded) coordinates, so recompute
 * -based seed derivation on the Rust side would silently diverge from what
 * TS actually ran.
 */
function encodeSeed(seed: IntrinsicReconstructionSeed) {
  return {
    role: seed.role,
    canonicalGeometryHash: seed.canonicalGeometryHash,
    placements: seed.placedCollisionGeometries.map(encodeSeedPlacement),
    stepTrace: encodeStepTrace(seed.stepTrace),
    metrics: encodeMetrics(seed.metrics)
  }
}
function encodeRun(run: IntrinsicReconstructionRun) {
  return {
    role: run.role,
    sourceEndpointHash: run.sourceEndpointHash ?? null,
    candidateMode: candidateModeLabel(run.candidateMode),
    pieceIds: run.pieceIds,
    effectiveOrderKey: run.effectiveOrderKey,
    status: run.status,
    duplicateOf: run.duplicateOf ?? null,
    requestedCandidateEvaluations: encodeOptionalNum(run.requestedCandidateEvaluations),
    consumedCandidateEvaluations: encodeOptionalNum(run.consumedCandidateEvaluations),
    placements: run.placedCollisionGeometries.map((p) => encodePlacement(p.placement)),
    stepTrace: encodeStepTrace(run.stepTrace),
    gapFillEvidence: encodeGapFillEvidence(run.gapFillEvidence),
    metrics: encodeMetrics(run.metrics)
  }
}
function encodePortfolioResult(result: IntrinsicReconstructionPortfolioResult) {
  return {
    runs: result.runs.map(encodeRun),
    archive: result.archive.map(encodeRun),
    winner: result.winner === undefined ? null : encodeRun(result.winner),
    consumedCandidateEvaluations: f64Bits(result.consumedCandidateEvaluations),
    candidateEvaluationAccountingComplete: result.candidateEvaluationAccountingComplete
  }
}
function encodeEndpointOrders(
  orders: ReturnType<typeof buildCanonicalEndpointOrders>
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const { role, pieces } of orders) {
    out[role] = pieces.map((p) => p.pieceId ?? p.source.id)
  }
  return out
}

// =============================================================================
// Section A: `buildCanonicalEndpointOrders` pure sweep.
// =============================================================================
interface EndpointOrdersCase {
  readonly caseId: string
  // Axis-aligned rectangle pieces at [0,0]-[width,height], reconstructible in
  // Rust from these primitives alone (no full point-array encoding needed).
  readonly pieces: ReadonlyArray<{ readonly id: string; readonly width: string; readonly height: string }>
  readonly placements: ReadonlyArray<{ readonly id: string; readonly x: string; readonly y: string }>
  readonly orders: Record<string, string[]>
}
const endpointOrdersCases: EndpointOrdersCase[] = []

function preparedRect(id: string, width: number, height: number): IrregularPreparedPiece {
  return preparedPiece(id, rectanglePoints(width, height))
}
function realPlace(prepared: IrregularPreparedPiece, x: number, y: number): IrregularPlacedPiece {
  const transform = prepared.transforms[0]
  if (transform === undefined) throw new Error('missing transform')
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      pieceId: prepared.pieceId,
      sourcePieceId: prepared.source.id,
      placementReference: prepared.collisionGeometry.placementReference,
      transform: new IrregularTransform({
        translateX: x,
        translateY: y,
        rotationDeg: 0,
        mirrored: false
      })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: prepared.source.id,
      transform,
      polygon: prepared.collisionGeometry.collisionPolygon,
      bounds: prepared.collisionGeometry.sourceBounds
    })
  })
}

const ENDPOINT_ORDER_LAYOUTS: ReadonlyArray<{
  readonly key: string
  readonly pieces: ReadonlyArray<{ readonly id: string; readonly w: number; readonly h: number; readonly x: number; readonly y: number }>
  readonly omitLast: boolean
}> = [
  {
    key: 'triangle',
    pieces: [
      { id: 'first', w: 2, h: 2, x: 0, y: 0 },
      { id: 'second', w: 2, h: 2, x: 10, y: 20 },
      { id: 'third', w: 2, h: 2, x: 20, y: 10 }
    ],
    omitLast: false
  },
  {
    key: 'square',
    pieces: [
      { id: 'a', w: 3, h: 3, x: 0, y: 0 },
      { id: 'b', w: 3, h: 3, x: 20, y: 0 },
      { id: 'c', w: 3, h: 3, x: 0, y: 20 },
      { id: 'd', w: 3, h: 3, x: 20, y: 20 }
    ],
    omitLast: false
  },
  {
    key: 'line-ascending',
    pieces: [
      { id: 'p0', w: 2, h: 2, x: 0, y: 0 },
      { id: 'p1', w: 2, h: 2, x: 5, y: 0 },
      { id: 'p2', w: 2, h: 2, x: 10, y: 0 },
      { id: 'p3', w: 2, h: 2, x: 15, y: 0 }
    ],
    omitLast: false
  },
  {
    key: 'missing-position',
    pieces: [
      { id: 'q0', w: 2, h: 2, x: 0, y: 0 },
      { id: 'q1', w: 2, h: 2, x: 10, y: 10 },
      { id: 'q2', w: 2, h: 2, x: 20, y: 20 }
    ],
    omitLast: true
  },
  {
    key: 'tie-on-doubled-y',
    pieces: [
      { id: 'r0', w: 2, h: 2, x: 0, y: 0 },
      { id: 'r1', w: 2, h: 2, x: 10, y: 0 },
      { id: 'r2', w: 2, h: 2, x: 20, y: 0 }
    ],
    omitLast: false
  }
]
for (const layout of ENDPOINT_ORDER_LAYOUTS) {
  const prepared = layout.pieces.map(({ id, w, h }) => preparedRect(id, w, h))
  const placedCount = layout.omitLast ? layout.pieces.length - 1 : layout.pieces.length
  const placed = layout.pieces
    .slice(0, placedCount)
    .map(({ x, y }, index) => realPlace(prepared[index] as IrregularPreparedPiece, x, y))
  const orders = buildCanonicalEndpointOrders(prepared, placed)
  endpointOrdersCases.push({
    caseId: layout.key,
    pieces: layout.pieces.map(({ id, w, h }) => ({ id, width: f64Bits(w), height: f64Bits(h) })),
    placements: layout.pieces
      .slice(0, placedCount)
      .map(({ id, x, y }) => ({ id, x: f64Bits(x), y: f64Bits(y) })),
    orders: encodeEndpointOrders(orders)
  })
}

// =============================================================================
// Section B: `buildIntrinsicReconstructionSpecs` + family filter sweep.
// =============================================================================
interface SpecsCase {
  readonly caseId: string
  readonly pieces: ReadonlyArray<{ readonly id: string; readonly width: string; readonly height: string }>
  readonly placements: ReadonlyArray<{ readonly id: string; readonly x: string; readonly y: string }>
  readonly endpointHash: string
  readonly roleOrder: string[]
  readonly gapContainedCount: number
  readonly pureGrowthFamilyCount: number
  readonly gapContainedFamilyCount: number
  readonly allFamilyCount: number
  readonly focusedFamilyRoles: string[]
}
const specsCases: SpecsCase[] = []
const SPECS_LAYOUTS = ENDPOINT_ORDER_LAYOUTS.filter((layout) => !layout.omitLast)
for (const layout of SPECS_LAYOUTS) {
  const prepared = layout.pieces.map(({ id, w, h }) => preparedRect(id, w, h))
  const placed = layout.pieces.map(({ x, y }, index) =>
    realPlace(prepared[index] as IrregularPreparedPiece, x, y)
  )
  const endpointSeed: IntrinsicReconstructionSeed = {
    role: 'canonical-grid',
    canonicalGeometryHash: `endpoint-${layout.key}`,
    placedCollisionGeometries: placed,
    stepTrace: [],
    metrics: sampleMetrics(`endpoint-${layout.key}`, 5)
  }
  const specs = buildIntrinsicReconstructionSpecs(prepared, endpointSeed)
  specsCases.push({
    caseId: layout.key,
    pieces: layout.pieces.map(({ id, w, h }) => ({ id, width: f64Bits(w), height: f64Bits(h) })),
    placements: layout.pieces.map(({ id, x, y }) => ({ id, x: f64Bits(x), y: f64Bits(y) })),
    endpointHash: `endpoint-${layout.key}`,
    roleOrder: specs.map((s) => s.role),
    gapContainedCount: specs.filter((s) => typeof s.candidateMode === 'object').length,
    pureGrowthFamilyCount: specs.filter((s) =>
      intrinsicReconstructionSpecMatchesFamily(s, 'pure-growth')
    ).length,
    gapContainedFamilyCount: specs.filter((s) =>
      intrinsicReconstructionSpecMatchesFamily(s, 'gap-contained')
    ).length,
    allFamilyCount: specs.filter((s) => intrinsicReconstructionSpecMatchesFamily(s, 'all')).length,
    focusedFamilyRoles: specs
      .filter((s) => intrinsicReconstructionSpecMatchesFamily(s, 'endpoint-q90-right-to-left'))
      .map((s) => s.role)
  })
}

function sampleMetrics(hash: string, maximumSide: number): IntrinsicStrictCompletedMetrics {
  return {
    envelopeMaximumSideMm: maximumSide,
    envelopeAreaMm2: maximumSide * maximumSide,
    envelopeSpanMm: maximumSide * 2,
    enclosedCavityCount: 0,
    totalEnclosedCavityAreaMm2: 0,
    largestOccupiedHullGapRatio: 0,
    isolatedPieceCount: 0,
    positiveContactComponentCount: 1,
    largestPositiveContactComponentSize: 3,
    largestPositiveContactComponentRatio: 1,
    occupiedAreaOutsideLargestContactComponentMm2: 0,
    occupiedHullWasteRatio: 0,
    totalStructuralContacts: 2,
    dominantStructuralContacts: 2,
    contactUnits: 2,
    sharedBoundaryLengthMm: 4,
    canonicalGeometryHash: hash,
    runtimeMs: 1
  }
}

// =============================================================================
// Section C: `intrinsicReconstructionEffectiveOrderKey`/`intrinsicPreparedPieceClassKey`
// pure sweep.
// =============================================================================
interface OrderKeyCase {
  readonly caseId: string
  readonly pieces: ReturnType<typeof encodePreparedForCase>
  readonly classKeys: string[]
  readonly effectiveOrderKey: string
}
const orderKeyCases: OrderKeyCase[] = []
const CLASS_KEY_SHAPES: ReadonlyArray<{
  readonly id: string
  readonly points: ReadonlyArray<readonly [number, number]>
  readonly transformCount: number
}> = [
  { id: 'sq2', points: [[0, 0], [2, 0], [2, 2], [0, 2]], transformCount: 1 },
  { id: 'sq2b', points: [[0, 0], [2, 0], [2, 2], [0, 2]], transformCount: 1 },
  { id: 'rect32', points: [[0, 0], [3, 0], [3, 2], [0, 2]], transformCount: 1 },
  { id: 'tri', points: [[0, 0], [4, 0], [2, 3]], transformCount: 2 },
  { id: 'penta', points: [[0, 0], [2, 0], [3, 2], [1, 3], [-1, 2]], transformCount: 4 },
  { id: 'rect32-multi', points: [[0, 0], [3, 0], [3, 2], [0, 2]], transformCount: 3 }
]
const classKeyPieces = new Map<string, IrregularPreparedPiece>()
for (const shape of CLASS_KEY_SHAPES) {
  const points = shape.points.map(([x, y]) => point(x, y))
  classKeyPieces.set(shape.id, preparedPiece(shape.id, points, shape.transformCount))
}
for (const shape of CLASS_KEY_SHAPES) {
  const piece = classKeyPieces.get(shape.id)
  if (piece === undefined) continue
  orderKeyCases.push({
    caseId: `single-${shape.id}`,
    pieces: encodePreparedForCase([piece]),
    classKeys: [intrinsicPreparedPieceClassKey(piece)],
    effectiveOrderKey: intrinsicReconstructionEffectiveOrderKey([piece])
  })
}
// Order-independence for interchangeable geometry, order-sensitivity for
// distinct geometry (mirrors `tests/unit/intrinsicReconstructionPortfolio.test.ts`'s
// own "deduplicates ... without collapsing distinct shapes" case).
const orderPairs: ReadonlyArray<readonly [string, string]> = [
  ['sq2', 'sq2b'],
  ['sq2', 'rect32'],
  ['rect32', 'tri'],
  ['tri', 'penta']
]
for (const [firstId, secondId] of orderPairs) {
  const first = classKeyPieces.get(firstId)
  const second = classKeyPieces.get(secondId)
  if (first === undefined || second === undefined) continue
  orderKeyCases.push({
    caseId: `pair-forward-${firstId}-${secondId}`,
    pieces: encodePreparedForCase([first, second]),
    classKeys: [intrinsicPreparedPieceClassKey(first), intrinsicPreparedPieceClassKey(second)],
    effectiveOrderKey: intrinsicReconstructionEffectiveOrderKey([first, second])
  })
  orderKeyCases.push({
    caseId: `pair-reversed-${firstId}-${secondId}`,
    pieces: encodePreparedForCase([second, first]),
    classKeys: [intrinsicPreparedPieceClassKey(second), intrinsicPreparedPieceClassKey(first)],
    effectiveOrderKey: intrinsicReconstructionEffectiveOrderKey([second, first])
  })
}
// Real mixed61 hull shapes, several transform-count variations each.
for (let slot = 0; slot < 80; slot++) {
  const ring = fixtureHullRing(slot * 3 + 1)
  const transformCount = 1 + (slot % 4)
  const piece = preparedPiece(`m61-${slot}`, ring, transformCount)
  orderKeyCases.push({
    caseId: `mixed61-${slot}`,
    pieces: encodePreparedForCase([piece]),
    classKeys: [intrinsicPreparedPieceClassKey(piece)],
    effectiveOrderKey: intrinsicReconstructionEffectiveOrderKey([piece])
  })
}

// =============================================================================
// Section D: `retainIntrinsicReconstructionArchive` pure sweep.
// =============================================================================
interface ArchiveCase {
  readonly caseId: string
  readonly capacity: string
  readonly retainedHashes: string[]
}
const archiveCases: ArchiveCase[] = []
function sampleRun(
  hash: string,
  maximumSide: number,
  role: IntrinsicReconstructionRole,
  status: IntrinsicReconstructionRun['status'] = 'completed',
  metricsPresent = true
): IntrinsicReconstructionRun {
  return {
    role,
    sourceEndpointHash: undefined,
    candidateMode: 'pure-growth',
    pieceIds: [],
    effectiveOrderKey: '',
    status,
    duplicateOf: undefined,
    requestedCandidateEvaluations: undefined,
    consumedCandidateEvaluations: undefined,
    placedCollisionGeometries: [],
    stepTrace: [],
    gapFillEvidence: [],
    metrics: metricsPresent ? sampleMetrics(hash, maximumSide) : undefined,
    runtimeMs: 1
  }
}
archiveCases.push({
  caseId: 'dedup-dominated',
  capacity: f64Bits(INTRINSIC_RECONSTRUCTION_ARCHIVE_CAPACITY),
  retainedHashes: retainIntrinsicReconstructionArchive([
    sampleRun('larger', 20, 'reversed-priority'),
    sampleRun('smaller', 10, 'reversed-priority'),
    sampleRun('smaller', 10, 'reversed-priority')
  ]).map((r) => r.metrics.canonicalGeometryHash)
})
archiveCases.push({
  caseId: 'protected-seeds-fill-capacity',
  capacity: f64Bits(3),
  retainedHashes: retainIntrinsicReconstructionArchive(
    [
      sampleRun('canonical-seed', 20, 'canonical-grid'),
      sampleRun('legacy-seed', 18, 'legacy-absolute-envelope'),
      sampleRun('frontier-leader', 10, 'reversed-priority')
    ],
    3
  ).map((r) => r.metrics.canonicalGeometryHash)
})
archiveCases.push({
  caseId: 'settled-protected-not-privileged',
  capacity: f64Bits(1),
  retainedHashes: retainIntrinsicReconstructionArchive(
    [
      sampleRun('settled-seed', 20, 'settled-protected'),
      sampleRun('frontier-leader', 10, 'reversed-priority')
    ],
    1
  ).map((r) => r.metrics.canonicalGeometryHash)
})
archiveCases.push({
  caseId: 'incomplete-and-non-completed-runs-excluded',
  capacity: f64Bits(INTRINSIC_RECONSTRUCTION_ARCHIVE_CAPACITY),
  retainedHashes: retainIntrinsicReconstructionArchive([
    sampleRun('incomplete', 5, 'reversed-priority', 'incomplete', false),
    sampleRun('deadline', 5, 'reversed-priority', 'deadline', false),
    sampleRun('duplicate', 5, 'reversed-priority', 'duplicate-order', false),
    sampleRun('kept', 8, 'reversed-priority')
  ]).map((r) => r.metrics.canonicalGeometryHash)
})
for (let capacity = 0; capacity <= 6; capacity++) {
  const runs = [
    sampleRun('h1', 30, 'endpoint-q0-left-to-right'),
    sampleRun('h2', 25, 'endpoint-q0-right-to-left'),
    sampleRun('h3', 20, 'endpoint-q90-left-to-right'),
    sampleRun('h4', 15, 'endpoint-q90-right-to-left'),
    sampleRun('h5', 10, 'open-pocket-first'),
    sampleRun('canonical', 40, 'canonical-grid'),
    sampleRun('legacy', 35, 'legacy-absolute-envelope')
  ]
  archiveCases.push({
    caseId: `capacity-sweep-${capacity}`,
    capacity: f64Bits(capacity),
    retainedHashes: retainIntrinsicReconstructionArchive(runs, capacity).map(
      (r) => r.metrics.canonicalGeometryHash
    )
  })
}
archiveCases.push({
  caseId: 'negative-capacity-bounded-to-zero',
  capacity: f64Bits(-5),
  retainedHashes: retainIntrinsicReconstructionArchive(
    [sampleRun('only', 10, 'reversed-priority')],
    -5
  ).map((r) => r.metrics.canonicalGeometryHash)
})

// =============================================================================
// Section E-H: full `runIntrinsicReconstructionPortfolio` end-to-end cases.
// =============================================================================
interface PortfolioCase {
  readonly caseId: string
  readonly pieces: Array<{ readonly pieceId: string; readonly points: Array<{ x: string; y: string }> }>
  readonly seedRole: string
  readonly seed: ReturnType<typeof encodeSeed>
  readonly roleFamily: string
  readonly maximumRuntimeMsPerDecode: string | null
  readonly maximumTotalRuntimeMs: string | null
  readonly maximumCandidateEvaluationsPerDecode: string | null
  readonly maximumTotalCandidateEvaluations: string | null
  readonly outcome:
    | { readonly kind: 'success'; readonly result: ReturnType<typeof encodePortfolioResult> }
    | { readonly kind: 'failure'; readonly tag: string; readonly reason: string | null }
}
const portfolioCases: PortfolioCase[] = []

function encodePreparedForCase(pieces: ReadonlyArray<IrregularPreparedPiece>) {
  return pieces.map((p) => ({
    pieceId: (p.pieceId ?? p.source.id) as string,
    points: p.collisionGeometry.collisionPolygon.points.map((pt) => ({
      x: f64Bits(pt.x),
      y: f64Bits(pt.y)
    })),
    // Every portfolio-case piece built by this script carries exactly this
    // one transform (see `preparedPiece`'s `transformCount = 1` default) and
    // `allowMirror: false`/`placementReference: (0, 0)` -- recorded
    // explicitly anyway (not left as an assumed Rust-side constant) so the
    // Rust replay reconstructs each piece from this vector file alone.
    transforms: p.transforms.map((t) => ({
      index: f64Bits(t.index),
      rotationDeg: f64Bits(t.rotationDeg),
      mirrored: t.mirrored,
      reason: t.reason
    })),
    allowMirror: p.allowMirror,
    placementReference: {
      x: f64Bits(p.collisionGeometry.placementReference.x),
      y: f64Bits(p.collisionGeometry.placementReference.y)
    }
  }))
}

function realSeedFrom(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  role: IntrinsicReconstructionSeed['role']
): IntrinsicReconstructionSeed | undefined {
  const exit = runConstruct({
    allPreparedPieces: pieces,
    remainingPreparedPieces: pieces,
    frozenPlaced: [],
    candidateMode: 'pure-growth',
    maximumRuntimeMs: 120_000,
    captureCandidateEvaluationCount: true
  })
  if (exit._tag !== 'Success') return undefined
  const measured = measureIntrinsicSheetlessCompletedLayout(
    exit.value.state,
    exit.value.runtimeMs
  )
  if (measured === undefined) return undefined
  return {
    role,
    canonicalGeometryHash: measured.canonicalGeometryHash,
    placedCollisionGeometries: measured.placedCollisionGeometries,
    stepTrace: exit.value.stepTrace,
    metrics: measured.metrics
  }
}

function runPortfolioCase(
  caseId: string,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  seed: IntrinsicReconstructionSeed,
  roleFamily: IntrinsicReconstructionRoleFamily,
  options: {
    readonly maximumRuntimeMsPerDecode?: number
    readonly maximumTotalRuntimeMs?: number
    readonly maximumCandidateEvaluationsPerDecode?: number
    readonly maximumTotalCandidateEvaluations?: number
    readonly control?: Parameters<typeof runIntrinsicReconstructionPortfolio>[0]['control']
  } = {}
): void {
  const exit = runPortfolio({
    allPreparedPieces: pieces,
    baselineSeeds: [seed],
    roleFamily,
    ...(options.maximumRuntimeMsPerDecode === undefined
      ? {}
      : { maximumRuntimeMsPerDecode: options.maximumRuntimeMsPerDecode }),
    ...(options.maximumTotalRuntimeMs === undefined
      ? {}
      : { maximumTotalRuntimeMs: options.maximumTotalRuntimeMs }),
    ...(options.maximumCandidateEvaluationsPerDecode === undefined
      ? {}
      : { maximumCandidateEvaluationsPerDecode: options.maximumCandidateEvaluationsPerDecode }),
    ...(options.maximumTotalCandidateEvaluations === undefined
      ? {}
      : { maximumTotalCandidateEvaluations: options.maximumTotalCandidateEvaluations }),
    ...(options.control === undefined ? {} : { control: options.control })
  })
  const record: PortfolioCase = {
    caseId,
    pieces: encodePreparedForCase(pieces),
    seedRole: seed.role,
    seed: encodeSeed(seed),
    roleFamily,
    maximumRuntimeMsPerDecode: encodeOptionalNum(options.maximumRuntimeMsPerDecode),
    maximumTotalRuntimeMs: encodeOptionalNum(options.maximumTotalRuntimeMs),
    maximumCandidateEvaluationsPerDecode: encodeOptionalNum(
      options.maximumCandidateEvaluationsPerDecode
    ),
    maximumTotalCandidateEvaluations: encodeOptionalNum(options.maximumTotalCandidateEvaluations),
    outcome:
      exit._tag === 'Success'
        ? { kind: 'success', result: encodePortfolioResult(exit.value) }
        : (() => {
            const detail = failureDetail(exit.cause)
            return { kind: 'failure' as const, tag: detail.tag, reason: detail.reason ?? null }
          })()
  }
  portfolioCases.push(record)
}

const ROLE_FAMILIES: ReadonlyArray<IntrinsicReconstructionRoleFamily> = [
  'all',
  'pure-growth',
  'gap-contained',
  'endpoint-q90-right-to-left'
]

// Rectangle piece-set battery (2-4 pieces), ascending-X sizes so several
// deliberately trigger endpoint-order/duplicate-order collisions (Section F).
const RECT_SIZE_BATTERY: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[2, 2], [3, 2]],
  [[2, 2], [3, 2], [4, 2]],
  [[2, 3], [3, 4], [2, 2], [4, 3]],
  [[5, 2], [4, 2], [3, 2]],
  [[2, 2], [2, 2], [2, 2]],
  [[3, 3], [5, 2]],
  [[4, 4], [2, 6], [3, 3]],
  [[6, 2], [2, 6], [4, 4], [3, 5]]
]
function rectPieceSet(caseIndex: number, sizes: ReadonlyArray<readonly [number, number]>) {
  return sizes.map(([w, h], index) => preparedRect(`rc${caseIndex}-p${index}`, w, h))
}

RECT_SIZE_BATTERY.forEach((sizes, caseIndex) => {
  const pieces = rectPieceSet(caseIndex, sizes)
  const seed = realSeedFrom(pieces, 'settled-protected')
  if (seed === undefined) return
  for (const roleFamily of ROLE_FAMILIES) {
    runPortfolioCase(`rect${caseIndex}-${roleFamily}-generous`, pieces, seed, roleFamily, {
      maximumRuntimeMsPerDecode: 15_000,
      maximumTotalRuntimeMs: 60_000
    })
    runPortfolioCase(`rect${caseIndex}-${roleFamily}-production-shaped`, pieces, seed, roleFamily, {
      maximumRuntimeMsPerDecode: 15_000,
      maximumTotalRuntimeMs: 15_000,
      maximumCandidateEvaluationsPerDecode: 12_000,
      maximumTotalCandidateEvaluations: 12_000
    })
  }
  // Also cover the two other seed roles (metadata-only role tag, per
  // characterization -- `baselineSeedRuns` selects `candidateMode` purely
  // from this field, independent of how the layout was actually decoded).
  runPortfolioCase(`rect${caseIndex}-canonical-grid-seed`, pieces, { ...seed, role: 'canonical-grid' }, 'all', {
    maximumRuntimeMsPerDecode: 15_000,
    maximumTotalRuntimeMs: 60_000
  })
  runPortfolioCase(
    `rect${caseIndex}-legacy-absolute-envelope-seed`,
    pieces,
    { ...seed, role: 'legacy-absolute-envelope' },
    'all',
    { maximumRuntimeMsPerDecode: 15_000, maximumTotalRuntimeMs: 60_000 }
  )
})

// Real mixed61 hull combos.
const MIXED61_PORTFOLIO_COMBOS: ReadonlyArray<ReadonlyArray<number>> = [
  [2, 14],
  [5, 23, 41],
  [7, 19, 33, 52],
  [11, 26, 47],
  [3, 16, 29, 44],
  [9, 21, 38],
  [1, 30],
  [6, 24, 45],
  [13, 28, 50, 58],
  [4, 17, 36]
]
MIXED61_PORTFOLIO_COMBOS.forEach((combo, comboIndex) => {
  const pieces = combo.map((slot, index) =>
    preparedPiece(`m61c${comboIndex}-${index}`, fixtureHullRing(slot))
  )
  const seed = realSeedFrom(pieces, 'settled-protected')
  if (seed === undefined) return
  for (const roleFamily of ROLE_FAMILIES) {
    runPortfolioCase(`m61combo${comboIndex}-${roleFamily}`, pieces, seed, roleFamily, {
      maximumRuntimeMsPerDecode: 15_000,
      maximumTotalRuntimeMs: 60_000
    })
  }
})

// Section F: deliberately-colliding orderOwners cases. Pieces already sorted
// ascending by X, placed at matching ascending-X positions in the seed --
// forces `endpoint-q0-right-to-left` (dup of `reversed-priority`) and the two
// open-pocket-first endpoint duplicates (characterization §5.2/§6.4's
// "duplicate-order" scenario, mirrored from
// `tests/unit/intrinsicCapacityIntegration.test.ts`'s own golden path).
const DUPLICATE_ORDER_BATTERY: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [
  [[2, 2, 0], [2, 2, 10], [2, 2, 20]],
  [[3, 2, 0], [3, 2, 8], [3, 2, 16], [3, 2, 24]],
  [[2, 3, 0], [2, 3, 12]],
  [[2, 2, 0], [2, 2, 9], [2, 2, 18], [2, 2, 27]],
  [[4, 2, 0], [4, 2, 11], [4, 2, 22]]
]
DUPLICATE_ORDER_BATTERY.forEach((layout, index) => {
  const pieces = layout.map(([w, h], pieceIndex) => preparedRect(`dup${index}-p${pieceIndex}`, w, h))
  const placed = layout.map(([, , x], pieceIndex) =>
    realPlace(pieces[pieceIndex] as IrregularPreparedPiece, x, 0)
  )
  const seed: IntrinsicReconstructionSeed = {
    role: 'settled-protected',
    canonicalGeometryHash: `dup-endpoint-${index}`,
    placedCollisionGeometries: placed,
    stepTrace: [],
    metrics: sampleMetrics(`dup-endpoint-${index}`, 30)
  }
  for (const roleFamily of ROLE_FAMILIES) {
    runPortfolioCase(`dup${index}-${roleFamily}`, pieces, seed, roleFamily, {
      maximumRuntimeMsPerDecode: 15_000,
      maximumTotalRuntimeMs: 60_000
    })
  }
})

// Section G: deadline + evaluation-cap batteries.
RECT_SIZE_BATTERY.forEach((sizes, caseIndex) => {
  const pieces = rectPieceSet(caseIndex, sizes)
  const seed = realSeedFrom(pieces, 'settled-protected')
  if (seed === undefined) return
  for (const roleFamily of ROLE_FAMILIES) {
    runPortfolioCase(`rect${caseIndex}-${roleFamily}-deadline`, pieces, seed, roleFamily, {
      maximumTotalRuntimeMs: 0
    })
    runPortfolioCase(`rect${caseIndex}-${roleFamily}-evaluation-cap`, pieces, seed, roleFamily, {
      maximumCandidateEvaluationsPerDecode: 1,
      maximumTotalCandidateEvaluations: 1
    })
  }
})

// Section H: cancellation propagation. Uses irregular real mixed61 hull
// combos (not the axis-aligned rectangle battery): small rectangle sets
// collapse every pure-growth endpoint order into a `'duplicate-order'` of
// the seed (too few distinct orderings for 2-3 congruent rectangles), which
// would short-circuit *before* `constructIntrinsicStrictState` is ever
// called, never exercising the cancelling control at all.
MIXED61_PORTFOLIO_COMBOS.slice(0, 3).forEach((combo, caseIndex) => {
  const pieces = combo.map((slot, index) =>
    preparedPiece(`cancel${caseIndex}-${index}`, fixtureHullRing(slot))
  )
  const seed = realSeedFrom(pieces, 'settled-protected')
  if (seed === undefined) return
  runPortfolioCase(`cancel${caseIndex}`, pieces, seed, 'endpoint-q90-right-to-left', {
    control: {
      checkpoint: () =>
        Effect.fail(
          new IrregularNfpIfpControlAbortError({ reason: 'cancelled', message: 'cancelled' })
        )
    }
  })
})

// ===========================================================================
// Vector-count accounting and write-out.
// ===========================================================================
const totalVectorCount =
  endpointOrdersCases.length +
  specsCases.length +
  orderKeyCases.length +
  archiveCases.length +
  portfolioCases.length

if (totalVectorCount < 300) {
  throw new Error(`Expected >= 300 reconstruction vectors, got ${totalVectorCount}.`)
}

mkdirSync(VECTORS_DIR, { recursive: true })
const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-reconstruction.ts',
  generatingCommit: commit,
  description:
    'intrinsicReconstructionPortfolio.ts full-port coverage: (A) buildCanonicalEndpointOrders pure ' +
    'sweep, (B) buildIntrinsicReconstructionSpecs + intrinsicReconstructionSpecMatchesFamily sweep, ' +
    '(C) intrinsicReconstructionEffectiveOrderKey/intrinsicPreparedPieceClassKey pure sweep including ' +
    'real mixed61 hull shapes, (D) retainIntrinsicReconstructionArchive pure sweep (capacity bounds, ' +
    'canonical-hash dedup, the two-literal protectedSeeds role filter), and (E-H) full ' +
    'runIntrinsicReconstructionPortfolio end-to-end cases over small real mixed61-hull and rectangle ' +
    'piece sets seeded from a REAL completed sheetless decode, crossed with every roleFamily value, ' +
    'deliberately-colliding orderOwners duplicate-order cases, deadline (maximumTotalRuntimeMs: 0) and ' +
    'evaluation-cap (cap: 1) batteries, and cancellation propagation. f64 values are recorded as ' +
    'big-endian IEEE-754 bit-pattern hex strings for bit-exact comparison. runIntrinsicReconstructionPortfolio ' +
    'has no injectable timingNow seam in TS (real global performance.now() throughout, matching the Rust ' +
    'port shared-clock design documented on its own top doc); deadline cases therefore use ' +
    'maximumTotalRuntimeMs: 0 (deterministic regardless of wall-clock) and every recorded runtimeMs field ' +
    'is informational only, not part of the parity contract.',
  endpointOrdersCaseCount: endpointOrdersCases.length,
  endpointOrdersCases,
  specsCaseCount: specsCases.length,
  specsCases,
  orderKeyCaseCount: orderKeyCases.length,
  orderKeyCases,
  archiveCaseCount: archiveCases.length,
  archiveCases,
  portfolioCaseCount: portfolioCases.length,
  portfolioCases,
  totalVectorCount
}

writeFileSync(join(VECTORS_DIR, 'reconstruction.json'), JSON.stringify(output, null, 2) + '\n')

console.log(
  `Wrote ${endpointOrdersCases.length} endpoint-orders, ${specsCases.length} specs, ` +
    `${orderKeyCases.length} order-key, ${archiveCases.length} archive, and ${portfolioCases.length} ` +
    `portfolio cases (${totalVectorCount} total vectors, commit ${commit}) to ${VECTORS_DIR}`
)
