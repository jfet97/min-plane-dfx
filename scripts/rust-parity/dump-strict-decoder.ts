/**
 * Differential-vector generator for
 * `crates/irregular-nesting-native/src/search/strict_decoder.rs`.
 *
 * Per docs/planning/rust-irregular-backend/stage0-rulings.md R14: this script
 * imports the REAL production TS entry points from
 * `src/workers/algorithm/irregular/intrinsicStrictDecoder.ts` --
 *   - `constructIntrinsicStrictState` / `finalizeIntrinsicStrictState` (the
 *     two live halves production actually calls, per
 *     `strict-decoder-gap-family.md` §2.1/§1.2 -- `decodeIntrinsicStrictPriorityOrder`
 *     itself has no production caller and is not test-seamable via
 *     `timingNow`, so it is exercised only incidentally, not as the primary
 *     vector source)
 *   - `evaluateIntrinsicStrictCertificate`, `measureIntrinsicSheetlessCompletedLayout`,
 *     `rankIntrinsicStrictCompletedLayouts`, `selectIntrinsicStrictCompletedParetoFront`,
 *     `compareIntrinsicStrictCompletedLayoutDominance`, `intrinsicStrictCompletedLayoutDominates`
 *   - `transformCandidateOrder`, `canonicalLinearMetric`, `canonicalAreaMetric`,
 *     `measureIntrinsicStrictCanonicalEnvelope`
 * and evaluates them through the REAL Effect service layer stack
 * (`GeometryKernel.Live`, `GeometrySettings.Live`, `NfpIfpServiceLive` --
 * the same layer shape `nesting.worker.ts` wires into production, and the
 * exact shape `tests/unit/intrinsicStrictDecoder.test.ts` itself uses),
 * driven with `Effect.runSyncExit` (verified empirically: `GeometryKernel.Live`'s
 * `transformCollisionGeometry` and `NfpIfpServiceLive`'s
 * `generatePlacementCandidates` are synchronous-safe Effects for this
 * script's inputs -- no `Effect.runPromise` needed).
 *
 * Real mixed61 fixture-piece convex hulls (`computeConvexHull` over
 * `tests/fixtures/irregularSheetInvariance/mixed61-request.json` segment
 * endpoints -- the same technique `dump-nfp-ifp.ts` uses, since NFP/IFP
 * inputs must be strict-convex and raw un-hulled fixture rings are not
 * guaranteed convex) form every prepared piece's collision polygon. Each
 * piece carries a real multi-candidate `transforms` array (identity +
 * quarter-turns, some mirrored) so transform-family best-of selection is
 * genuinely exercised, not a single-candidate degenerate case.
 *
 * Determinism: every `constructIntrinsicStrictState` call in this script
 * supplies its own freshly-constructed `timingNow` seam -- a simple
 * incrementing counter starting at `1000` and advancing by `1` on every
 * call (`makeClock()` below) -- so `runtimeMs`, every phase-timing field,
 * and the request-fingerprint/integrity-hash inputs that embed them are
 * byte-for-byte reproducible. The Rust replay must construct an equivalent
 * `TimingNowFn` seam (a fresh `Cell<f64>`-backed closure, same start value,
 * same increment) for each case it replays, mirroring this exact sequence.
 * `maximumCandidateEvaluationCount`/`maximumRuntimeMs` are chosen per case so
 * cap/deadline firing is itself deterministic given this clock.
 *
 * Checkpoint round-trips do **not** attempt to serialize a full
 * `IrregularBeamState` snapshot into JSON and reconstruct it in Rust (that
 * type is a separate, complex, Arc-wrapped tower owned by a different file
 * this task must not edit). Instead each checkpoint case records: (a) the
 * first-stage checkpoint's own hash-bearing scalar fields
 * (`requestFingerprint`, `integrityHash`, `nextPieceIndex`,
 * `candidateEvaluationCount`, `activeRuntimeMs`, `phaseLedger`) for the Rust
 * port's **own**, independently-constructed first-stage checkpoint to match
 * byte-exactly (a SHA-256 hash match is only reachable if the Rust port's
 * canonical-JSON preimage bytes are themselves byte-identical to the TS
 * preimage, since SHA-256 is collision-resistant -- this is the practical,
 * verifiable form of "integrity-hash preimage byte-exact" given the
 * preimage-building functions themselves are TS-module-private and not
 * exported); and (b) the fully-uninterrupted decode's final result, which
 * the Rust port's own **resumed** (checkpoint-fed) second-stage call must
 * reproduce exactly -- proving the checkpoint/resume round-trip reconstructs
 * the identical terminal state an uncapped run reaches.
 *
 * Sections (each independently contributes to the >= 400 total asserted
 * below):
 *   A. Pure helper sweeps: `transformCandidateOrder` (stable-sort order over
 *      hand-built transform-candidate batteries), `canonicalLinearMetric`/
 *      `canonicalAreaMetric` (numeric sweep across positive/negative/zero/
 *      half-integer-tie values -- the JS `Math.round` ties-toward-`+Infinity`
 *      hazard), `measureIntrinsicStrictCanonicalEnvelope` (over real placed
 *      layouts produced by section B).
 *   B. Full `constructIntrinsicStrictState` + `finalizeIntrinsicStrictState`
 *      decode runs across small real mixed61-hull piece sets (2-6 pieces)
 *      crossed with all four `candidateMode` values, recording status,
 *      terminal rotation/hash, every metrics/certificate field, every
 *      placement's transform (bit-exact), `unplacedPieceIds`, the full
 *      `stepTrace`, `candidateEvaluationCount`, and `runtimeMs`.
 *   C. Checkpoint round-trip cases (`maximumCompletedPieceBoundaries` at
 *      every valid boundary for several piece sets, `capturePhaseTimings`
 *      both on and off).
 *   D. Deterministic candidate-evaluation-cap truncation cases.
 *   E. Deterministic deadline-abort cases via the `timingNow` seam (tiny
 *      `maximumRuntimeMs`), including one case with a nonzero
 *      `previousActiveRuntimeMs` (fed through a checkpoint) to prove the
 *      accumulated-runtime addition is itself exact.
 *   F. Pareto/ranking cases: `rankIntrinsicStrictCompletedLayouts`,
 *      `selectIntrinsicStrictCompletedParetoFront`, and
 *      `compareIntrinsicStrictCompletedLayoutDominance` applied to pools of
 *      real completed-metrics objects collected from section B's decode
 *      runs (plus shuffled-input-order variants proving the peeling order is
 *      value-determined, not input-order-determined).
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-strict-decoder.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/strict-decoder.json
 */
import { Cause, Effect } from 'effect'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import { DEFAULT_IRREGULAR_NESTING_SETTINGS } from '../../src/shared/irregular/defaults.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransformCandidate,
  type IrregularPlacement
} from '../../src/shared/irregular/domain.js'
import { computeConvexHull } from '../../src/workers/irregular/core/convexHullCore.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import {
  canonicalAreaMetric,
  canonicalLinearMetric,
  compareIntrinsicStrictCompletedLayoutDominance,
  constructIntrinsicStrictState,
  evaluateIntrinsicStrictCertificate,
  finalizeIntrinsicStrictState,
  intrinsicStrictCompletedLayoutDominates,
  measureIntrinsicSheetlessCompletedLayout,
  measureIntrinsicStrictCanonicalEnvelope,
  rankIntrinsicStrictCompletedLayouts,
  selectIntrinsicStrictCompletedParetoFront,
  transformCandidateOrder,
  type IntrinsicStrictCandidateMode,
  type IntrinsicStrictCompletedMetrics,
  type IntrinsicStrictConstructResult,
  type IntrinsicStrictDirectCheckpoint,
  type IntrinsicStrictStepTrace
} from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const VECTORS_DIR = join(REPO_ROOT, 'crates', 'irregular-nesting-native', 'tests', 'vectors')
const MIXED61_FIXTURE_PATH = join(
  REPO_ROOT,
  'tests/fixtures/irregularSheetInvariance/mixed61-request.json'
)

function generatingCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim()
}

// ---------------------------------------------------------------------------
// f64 -> exact big-endian IEEE-754 bit-pattern hex string (matches
// dump-nfp-ifp.ts's/dump-gap-family.ts's own `f64Bits` convention exactly).
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

// ---------------------------------------------------------------------------
// Deterministic timingNow seam -- see this file's top-level doc.
// ---------------------------------------------------------------------------
function makeClock(): () => number {
  let clock = 1000
  return () => {
    clock += 1
    return clock
  }
}
const CLOCK_START_DOC_VALUE = 1000 // documented for the Rust replay; not itself hashed.

// ---------------------------------------------------------------------------
// Domain-object construction helpers (mirror
// `tests/unit/intrinsicStrictDecoder.test.ts`'s own helpers plus
// `dump-nfp-ifp.ts`'s real mixed61 hull-ring loader).
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

function transformCandidate(
  index: number,
  rotationDeg: number,
  mirrored = false
): IrregularTransformCandidate {
  return new IrregularTransformCandidate({ index, rotationDeg, mirrored, reason: 'configured' })
}

function preparedPiece(
  id: string,
  points: ReadonlyArray<IrregularPoint>,
  transforms: ReadonlyArray<IrregularTransformCandidate>
): IrregularPreparedPiece {
  const shape = new IrregularPolygon({ points })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(id),
    source: sourcePiece(id),
    allowMirror: true,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: PieceId.make(id),
      sourceBounds: boundsOf(points),
      sampledPoints: points,
      convexHull: shape,
      collisionPolygon: shape,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms
  })
}

function sheetSpec(width: number, height: number, label = 'dump-strict-decoder sheet'): SheetSpec {
  return new SheetSpec({ width, height, label })
}

// ---------------------------------------------------------------------------
// Real mixed61 fixture-piece hull rings (mirrors dump-nfp-ifp.ts's
// `fixtureHullRing`).
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

/** A small, real, multi-transform prepared piece drawn from fixture index `slot`. */
function fixturePreparedPiece(id: string, slot: number, mirrorToo = false): IrregularPreparedPiece {
  const transforms = mirrorToo
    ? [
        transformCandidate(0, 0, false),
        transformCandidate(1, 90, false),
        transformCandidate(2, 0, true)
      ]
    : [transformCandidate(0, 0, false), transformCandidate(1, 90, false)]
  return preparedPiece(id, fixtureHullRing(slot), transforms)
}

// ---------------------------------------------------------------------------
// Encoding helpers.
// ---------------------------------------------------------------------------
function encodePoint(p: { readonly x: number; readonly y: number }) {
  return { x: f64Bits(p.x), y: f64Bits(p.y) }
}
function encodePoints(points: ReadonlyArray<{ readonly x: number; readonly y: number }>) {
  return points.map(encodePoint)
}
function encodeTransformCandidate(t: IrregularTransformCandidate) {
  return {
    index: f64Bits(t.index),
    rotationDeg: f64Bits(t.rotationDeg),
    mirrored: t.mirrored,
    reason: t.reason
  }
}
function encodePreparedPiece(piece: IrregularPreparedPiece) {
  return {
    pieceId: piece.pieceId ?? piece.source.id,
    points: encodePoints(piece.collisionGeometry.collisionPolygon.points),
    transforms: piece.transforms.map(encodeTransformCandidate)
  }
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
function encodeOptionalNum(value: number | undefined) {
  return value === undefined ? null : f64Bits(value)
}
function encodeLocalScore(score: IntrinsicStrictStepTrace['selectedScore']) {
  if (score === undefined) return null
  return {
    maximumSideMm: f64Bits(score.maximumSideMm),
    envelopeAreaMm2: f64Bits(score.envelopeAreaMm2),
    envelopeSpanMm: f64Bits(score.envelopeSpanMm),
    sharedBoundaryLengthMm: f64Bits(score.sharedBoundaryLengthMm),
    canonicalCombinedGeometryKey: score.canonicalCombinedGeometryKey,
    exact:
      score.exact === undefined
        ? null
        : {
            maximumSideGrid: f64Bits(score.exact.maximumSideGrid),
            envelopeAreaGrid2: score.exact.envelopeAreaGrid2,
            envelopeSpanGrid: f64Bits(score.exact.envelopeSpanGrid)
          }
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
    canonicalGeometryHash: metrics.canonicalGeometryHash,
    runtimeMs: f64Bits(metrics.runtimeMs),
    exact:
      metrics.exact === undefined
        ? null
        : {
            envelopeMaximumSideGrid: f64Bits(metrics.exact.envelopeMaximumSideGrid),
            envelopeAreaGrid2: metrics.exact.envelopeAreaGrid2,
            envelopeSpanGrid: f64Bits(metrics.exact.envelopeSpanGrid),
            totalEnclosedCavityDoubledAreaGrid2: metrics.exact.totalEnclosedCavityDoubledAreaGrid2,
            largestOccupiedHullGapDoubledAreaGrid2:
              metrics.exact.largestOccupiedHullGapDoubledAreaGrid2,
            occupiedHullDoubledAreaGrid2: metrics.exact.occupiedHullDoubledAreaGrid2,
            occupiedHullWasteDoubledAreaGrid2: metrics.exact.occupiedHullWasteDoubledAreaGrid2,
            largestPositiveContactComponentSize: f64Bits(
              metrics.exact.largestPositiveContactComponentSize
            ),
            placedPieceCount: f64Bits(metrics.exact.placedPieceCount),
            occupiedOutsideLargestContactComponentDoubledAreaGrid2:
              metrics.exact.occupiedOutsideLargestContactComponentDoubledAreaGrid2
          }
  }
}
function encodeCertificate(certificate: ReturnType<typeof evaluateIntrinsicStrictCertificate> | undefined) {
  if (certificate === undefined) return null
  return {
    passes: certificate.passes,
    violatedFloors: certificate.violatedFloors,
    relativeDeficitSum: f64Bits(certificate.relativeDeficitSum),
    exactRelativeDeficitNumerator: certificate.exactRelativeDeficitNumerator ?? null,
    exactRelativeDeficitDenominator: certificate.exactRelativeDeficitDenominator ?? null
  }
}
function encodePhaseLedger(checkpoint: IntrinsicStrictDirectCheckpoint) {
  const ledger = checkpoint.phaseLedger
  if (ledger === undefined) return null
  const cs = ledger.candidateState
  return {
    candidateGenerationMs: f64Bits(ledger.candidateGenerationMs),
    candidateStateScoringMs: f64Bits(ledger.candidateStateScoringMs),
    candidateState: {
      placementObjectMs: f64Bits(cs.placementObjectMs),
      statePlacementMs: f64Bits(cs.statePlacementMs),
      statePlacementCanonicalEntryKeyMs: f64Bits(cs.statePlacementCanonicalEntryKeyMs),
      statePlacementSpatialIndexMs: f64Bits(cs.statePlacementSpatialIndexMs),
      statePlacementContactMeasurementMs: f64Bits(cs.statePlacementContactMeasurementMs),
      statePlacementStateAssemblyMs: f64Bits(cs.statePlacementStateAssemblyMs),
      statePlacementBookkeepingMs: f64Bits(cs.statePlacementBookkeepingMs),
      bottomLeftAnchoringMs: f64Bits(cs.bottomLeftAnchoringMs),
      envelopeScoringMs: f64Bits(cs.envelopeScoringMs),
      gapClassificationMs: f64Bits(cs.gapClassificationMs),
      candidateSelectionMs: f64Bits(cs.candidateSelectionMs),
      totalMs: f64Bits(cs.totalMs)
    }
  }
}
function encodeCheckpoint(checkpoint: IntrinsicStrictDirectCheckpoint) {
  return {
    version: checkpoint.version,
    producerRole: checkpoint.producerRole,
    requestFingerprint: checkpoint.requestFingerprint,
    integrityHash: checkpoint.integrityHash,
    nextPieceIndex: f64Bits(checkpoint.nextPieceIndex),
    stepTraceLength: f64Bits(checkpoint.stepTrace.length),
    candidateEvaluationCount: f64Bits(checkpoint.candidateEvaluationCount),
    activeRuntimeMs: f64Bits(checkpoint.activeRuntimeMs),
    phaseLedger: encodePhaseLedger(checkpoint)
  }
}

// ---------------------------------------------------------------------------
// Effect layer runners.
// ---------------------------------------------------------------------------
function runConstruct(
  input: Parameters<typeof constructIntrinsicStrictState>[0]
): ReturnType<typeof Effect.runSyncExit<IntrinsicStrictConstructResult, unknown>> {
  return Effect.runSyncExit(
    constructIntrinsicStrictState(input).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  ) as ReturnType<typeof Effect.runSyncExit<IntrinsicStrictConstructResult, unknown>>
}

interface DecodedResult {
  readonly exitTag: 'Success' | 'Failure'
  readonly failure?: { readonly tag: string; readonly reason?: string; readonly message?: string }
  readonly status?: string
  readonly terminalRotationDeg: number | null
  readonly canonicalGeometryHash: string | null
  readonly placements: ReturnType<typeof encodePlacement>[]
  readonly unplacedPieceIds: string[]
  readonly metrics: ReturnType<typeof encodeMetrics>
  readonly certificate: ReturnType<typeof encodeCertificate>
  readonly stepTrace: ReturnType<typeof encodeStepTrace>
  readonly candidateEvaluationCount: string | null
  readonly runtimeMs: string
  readonly truncationReason: string | null
  readonly pauseReason: string | null
}

/**
 * Extracts the first typed failure from an `Exit.Failure`'s `Cause` via
 * `Cause.findFail`. Two layers of "debug-display-only, not real" shape
 * verified empirically here, neither safe to rely on via plain property
 * access:
 *   - `Cause` itself: `Object.keys(cause)` is `['~effect/Cause', 'reasons']`;
 *     `cause.failures` is `undefined` at runtime even though
 *     `console.log`/`JSON.stringify` render a synthetic
 *     `{_id:'Cause', failures:[...]}` shape for humans.
 *   - `Cause.findFail`'s returned `Result`: `Object.keys(result)` is
 *     `['success']` (the real field holding the found `{_tag:'Fail', error}`
 *     payload on a `_tag: 'Success'` result); `result.value` is `undefined`
 *     at runtime even though `console.log` renders a synthetic
 *     `{_id:'Result', _tag:'Success', value:{...}}` shape for humans.
 */
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

/** Runs one full construct+finalize decode, returning an encoded, JSON-ready result. */
function runDecode(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  candidateMode: IntrinsicStrictCandidateMode,
  finalSheet: SheetSpec,
  options: {
    readonly maximumRuntimeMs?: number
    readonly maximumCandidateEvaluationCount?: number
    readonly maximumCompletedPieceBoundaries?: number
    readonly capturePhaseTimings?: boolean
    readonly checkpoint?: IntrinsicStrictDirectCheckpoint
    readonly timingNow?: () => number
  } = {}
): {
  readonly decoded: DecodedResult
  readonly constructed: IntrinsicStrictConstructResult | undefined
  readonly rawMetrics: IntrinsicStrictCompletedMetrics | undefined
} {
  const timingNow = options.timingNow ?? makeClock()
  const exit = runConstruct({
    allPreparedPieces: pieces,
    remainingPreparedPieces: pieces,
    frozenPlaced: [],
    candidateMode,
    maximumRuntimeMs: options.maximumRuntimeMs ?? 120_000,
    captureCandidateEvaluationCount: true,
    capturePhaseTimings: options.capturePhaseTimings ?? false,
    timingNow,
    ...(options.maximumCandidateEvaluationCount === undefined
      ? {}
      : { maximumCandidateEvaluationCount: options.maximumCandidateEvaluationCount }),
    ...(options.maximumCompletedPieceBoundaries === undefined
      ? {}
      : { maximumCompletedPieceBoundaries: options.maximumCompletedPieceBoundaries }),
    ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint })
  })
  if (exit._tag === 'Failure') {
    return {
      decoded: {
        exitTag: 'Failure',
        failure: failureDetail(exit.cause),
        terminalRotationDeg: null,
        canonicalGeometryHash: null,
        placements: [],
        unplacedPieceIds: [],
        metrics: null,
        certificate: null,
        stepTrace: [],
        candidateEvaluationCount: null,
        runtimeMs: f64Bits(Number.NaN),
        truncationReason: null,
        pauseReason: null
      },
      constructed: undefined,
      rawMetrics: undefined
    }
  }
  const constructed = exit.value
  const finalizeExit = Effect.runSyncExit(finalizeIntrinsicStrictState(finalSheet, constructed))
  if (finalizeExit._tag === 'Failure') {
    return {
      decoded: {
        exitTag: 'Failure',
        failure: failureDetail(finalizeExit.cause),
        terminalRotationDeg: null,
        canonicalGeometryHash: null,
        placements: [],
        unplacedPieceIds: [],
        metrics: null,
        certificate: null,
        stepTrace: encodeStepTrace(constructed.stepTrace),
        candidateEvaluationCount: encodeOptionalNum(constructed.candidateEvaluationCount),
        runtimeMs: f64Bits(Number.NaN),
        truncationReason: constructed.truncationReason ?? null,
        pauseReason: constructed.pauseReason ?? null
      },
      constructed,
      rawMetrics: undefined
    }
  }
  const finalized = finalizeExit.value
  return {
    decoded: {
      exitTag: 'Success',
      status: finalized.status,
      terminalRotationDeg: finalized.terminalRotationDeg ?? null,
      canonicalGeometryHash: finalized.canonicalGeometryHash ?? null,
      placements: finalized.placements.map(encodePlacement),
      unplacedPieceIds: [...finalized.unplacedPieceIds],
      metrics: encodeMetrics(finalized.metrics),
      certificate: encodeCertificate(finalized.certificate),
      stepTrace: encodeStepTrace(finalized.stepTrace),
      candidateEvaluationCount: encodeOptionalNum(constructed.candidateEvaluationCount),
      runtimeMs: f64Bits(finalized.runtimeMs),
      truncationReason: constructed.truncationReason ?? null,
      pauseReason: constructed.pauseReason ?? null
    },
    constructed,
    rawMetrics: finalized.status === 'completed' ? finalized.metrics : undefined
  }
}

// ---------------------------------------------------------------------------
// Shared settings/sheet fixtures.
// ---------------------------------------------------------------------------
const NESTING_SETTINGS_JSON = JSON.parse(JSON.stringify(DEFAULT_IRREGULAR_NESTING_SETTINGS))
const WIDE_SHEET = sheetSpec(1200, 1200, 'wide')
const TINY_SHEET = sheetSpec(10, 10, 'tiny-infeasible')
const CANDIDATE_MODES: IntrinsicStrictCandidateMode[] = [
  'pure-growth',
  'legacy-absolute-envelope',
  'contact-band',
  { kind: 'gap-contained' }
]

/** Small, real, deterministic piece sets drawn from distinct mixed61 slots. */
function pieceSet(ids: ReadonlyArray<[label: string, slot: number, mirror?: boolean]>): IrregularPreparedPiece[] {
  return ids.map(([label, slot, mirror]) => fixturePreparedPiece(label, slot, mirror ?? false))
}

const PIECE_SETS: ReadonlyArray<{ readonly label: string; readonly pieces: IrregularPreparedPiece[] }> = [
  { label: 'pair-0-5', pieces: pieceSet([['a', 0], ['b', 5]]) },
  { label: 'pair-0-1', pieces: pieceSet([['a', 0], ['b', 1]]) },
  { label: 'pair-mirror', pieces: pieceSet([['a', 2, true], ['b', 8, true]]) },
  { label: 'triple-0-5-10', pieces: pieceSet([['a', 0], ['b', 5], ['c', 10]]) },
  { label: 'triple-3-7-12', pieces: pieceSet([['a', 3], ['b', 7], ['c', 12]]) },
  { label: 'triple-repeat-shape', pieces: pieceSet([['a', 0], ['b', 1], ['c', 2]]) },
  { label: 'quad-0-5-10-15', pieces: pieceSet([['a', 0], ['b', 5], ['c', 10], ['d', 15]]) },
  { label: 'quad-20-25-30-35', pieces: pieceSet([['a', 20], ['b', 25], ['c', 30], ['d', 35]]) },
  { label: 'quad-mixed-mirror', pieces: pieceSet([['a', 4, true], ['b', 9], ['c', 14, true], ['d', 19]]) },
  {
    label: 'penta-0-5-10-15-20',
    pieces: pieceSet([['a', 0], ['b', 5], ['c', 10], ['d', 15], ['e', 20]])
  },
  {
    label: 'penta-40-43-46-49-52',
    pieces: pieceSet([['a', 40], ['b', 43], ['c', 46], ['d', 49], ['e', 52]])
  },
  {
    label: 'hexa-0-10-20-30-40-50',
    pieces: pieceSet([['a', 0], ['b', 10], ['c', 20], ['d', 30], ['e', 40], ['f', 50]])
  },
  { label: 'triple-close-siblings', pieces: pieceSet([['a', 0], ['b', 0], ['c', 0]]) },
  { label: 'quad-close-siblings', pieces: pieceSet([['a', 5], ['b', 5], ['c', 5], ['d', 5]]) },
  { label: 'single-piece', pieces: pieceSet([['a', 0]]) }
]

// =============================================================================
// Section A: pure helper sweeps.
// =============================================================================
interface TransformOrderCase {
  readonly caseLabel: string
  readonly input: ReturnType<typeof encodeTransformCandidate>[]
  readonly sortedIndices: string[]
}
const transformOrderCases: TransformOrderCase[] = []
function addTransformOrderCase(caseLabel: string, transforms: IrregularTransformCandidate[]): void {
  const sorted = [...transforms].sort(transformCandidateOrder)
  transformOrderCases.push({
    caseLabel,
    input: transforms.map(encodeTransformCandidate),
    sortedIndices: sorted.map((t) => f64Bits(t.index))
  })
}
addTransformOrderCase('already-sorted', [
  transformCandidate(0, 0),
  transformCandidate(1, 90),
  transformCandidate(2, 180)
])
addTransformOrderCase('reverse-order', [
  transformCandidate(2, 270),
  transformCandidate(1, 90),
  transformCandidate(0, 0)
])
addTransformOrderCase('rotation-desc-index-fixed', [
  new IrregularTransformCandidate({ index: 0, rotationDeg: 270, mirrored: false, reason: 'configured' }),
  new IrregularTransformCandidate({ index: 1, rotationDeg: 90, mirrored: false, reason: 'configured' })
])
addTransformOrderCase('mirrored-tiebreak', [
  new IrregularTransformCandidate({ index: 0, rotationDeg: 0, mirrored: true, reason: 'configured' }),
  new IrregularTransformCandidate({ index: 0, rotationDeg: 0, mirrored: false, reason: 'configured' })
])
addTransformOrderCase('reason-tiebreak', [
  new IrregularTransformCandidate({ index: 0, rotationDeg: 0, mirrored: false, reason: 'orthogonal' }),
  new IrregularTransformCandidate({ index: 0, rotationDeg: 0, mirrored: false, reason: 'edge_alignment' }),
  new IrregularTransformCandidate({ index: 0, rotationDeg: 0, mirrored: false, reason: 'configured' })
])
addTransformOrderCase('single-element', [transformCandidate(0, 0)])
for (let batch = 0; batch < 12; batch += 1) {
  const seedTransforms = [
    transformCandidate((batch * 3) % 5, (batch * 37) % 360),
    transformCandidate((batch * 7 + 1) % 5, (batch * 91) % 360, batch % 2 === 0),
    transformCandidate((batch * 11 + 2) % 5, (batch * 53) % 360)
  ]
  addTransformOrderCase(`sweep-batch-${batch}`, seedTransforms)
}

interface MetricRoundingCase {
  readonly caseLabel: string
  readonly valueMm: string
  readonly linearGrid: string
  readonly areaValueMm2: string
  readonly areaGrid: string
}
const metricRoundingCases: MetricRoundingCase[] = []
const ROUNDING_SWEEP_VALUES = [
  0, -0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.0005, -0.0005, 0.0004999, -0.0004999, 3.0005, -3.0005,
  10.5, -10.5, 100.5, -100.5, 0.00025, -0.00025, 123.456, -123.456, 1e-7, -1e-7, 999999.9999995,
  -999999.9999995, 0.1, -0.1, 7.7777, -7.7777
]
for (const value of ROUNDING_SWEEP_VALUES) {
  metricRoundingCases.push({
    caseLabel: `round-${value}`,
    valueMm: f64Bits(value),
    linearGrid: f64Bits(canonicalLinearMetric(value)),
    areaValueMm2: f64Bits(value),
    areaGrid: f64Bits(canonicalAreaMetric(value))
  })
}

// =============================================================================
// Section B: full decode runs.
// =============================================================================
interface DecodeCase {
  readonly caseLabel: string
  readonly candidateMode: string
  readonly pieces: ReturnType<typeof encodePreparedPiece>[]
  readonly finalSheetWidth: string
  readonly finalSheetHeight: string
  readonly maximumRuntimeMs: string
  readonly result: DecodedResult
}
const decodeCases: DecodeCase[] = []
/** Completed-layout metrics pool for section F, collected as a side effect of section B. */
const completedMetricsPool: IntrinsicStrictCompletedMetrics[] = []

function candidateModeLabel(mode: IntrinsicStrictCandidateMode): string {
  return typeof mode === 'object' ? 'gap-contained' : mode
}

for (const set of PIECE_SETS) {
  for (const mode of CANDIDATE_MODES) {
    const sheet = WIDE_SHEET
    const { decoded, rawMetrics } = runDecode(set.pieces, mode, sheet, {})
    decodeCases.push({
      caseLabel: `${set.label}__${candidateModeLabel(mode)}`,
      candidateMode: candidateModeLabel(mode),
      pieces: set.pieces.map(encodePreparedPiece),
      finalSheetWidth: f64Bits(sheet.width),
      finalSheetHeight: f64Bits(sheet.height),
      maximumRuntimeMs: f64Bits(120_000),
      result: decoded
    })
    if (rawMetrics !== undefined) {
      completedMetricsPool.push(rawMetrics)
    }
  }
}

// Tiny-sheet infeasibility cases (real pieces too large for the sheet).
for (const set of PIECE_SETS.slice(0, 6)) {
  const { decoded } = runDecode(set.pieces, 'pure-growth', TINY_SHEET, {})
  decodeCases.push({
    caseLabel: `${set.label}__tiny-sheet-infeasible`,
    candidateMode: 'pure-growth',
    pieces: set.pieces.map(encodePreparedPiece),
    finalSheetWidth: f64Bits(TINY_SHEET.width),
    finalSheetHeight: f64Bits(TINY_SHEET.height),
    maximumRuntimeMs: f64Bits(120_000),
    result: decoded
  })
}

// =============================================================================
// Section A (continued): `measureIntrinsicSheetlessCompletedLayout` called
// directly (not merely transitively through `finalizeIntrinsicStrictState`)
// on real constructed states.
// =============================================================================
interface MeasureCompletedLayoutCase {
  readonly caseLabel: string
  readonly candidateMode: string
  readonly pieces: ReturnType<typeof encodePreparedPiece>[]
  readonly runtimeMs: string
  readonly result:
    | { readonly defined: true; readonly canonicalGeometryIdentity: string; readonly canonicalGeometryHash: string; readonly metrics: ReturnType<typeof encodeMetrics> }
    | { readonly defined: false }
}
const measureCompletedLayoutCases: MeasureCompletedLayoutCase[] = []
for (const set of PIECE_SETS) {
  const { constructed } = runDecode(set.pieces, 'pure-growth', WIDE_SHEET, {})
  if (constructed === undefined) continue
  const runtimeMsInput = 42
  const result = measureIntrinsicSheetlessCompletedLayout(constructed.state, runtimeMsInput)
  measureCompletedLayoutCases.push({
    caseLabel: `${set.label}__measure-completed`,
    candidateMode: 'pure-growth',
    pieces: set.pieces.map(encodePreparedPiece),
    runtimeMs: f64Bits(runtimeMsInput),
    result:
      result === undefined
        ? { defined: false }
        : {
            defined: true,
            canonicalGeometryIdentity: result.canonicalGeometryIdentity,
            canonicalGeometryHash: result.canonicalGeometryHash,
            metrics: encodeMetrics(result.metrics)
          }
  })
}

// =============================================================================
// Section A (continued): `measureIntrinsicStrictCanonicalEnvelope` over real
// completed layouts collected above.
// =============================================================================
interface EnvelopeCase {
  readonly caseLabel: string
  readonly placedPoints: ReturnType<typeof encodePoints>[]
  readonly translateX: string[]
  readonly translateY: string[]
  readonly result:
    | { readonly defined: true; readonly maximumSideMm: string; readonly envelopeAreaMm2: string; readonly envelopeSpanMm: string }
    | { readonly defined: false }
}
const envelopeCases: EnvelopeCase[] = []
function addEnvelopeCase(caseLabel: string, placed: ReadonlyArray<IrregularPlacedPiece>): void {
  const result = measureIntrinsicStrictCanonicalEnvelope(placed)
  envelopeCases.push({
    caseLabel,
    placedPoints: placed.map((p) => encodePoints(p.collisionGeometry.polygon.points)),
    translateX: placed.map((p) => f64Bits(p.placement.transform.translateX)),
    translateY: placed.map((p) => f64Bits(p.placement.transform.translateY)),
    result:
      result === undefined
        ? { defined: false }
        : {
            defined: true,
            maximumSideMm: f64Bits(result.maximumSideMm),
            envelopeAreaMm2: f64Bits(result.envelopeAreaMm2),
            envelopeSpanMm: f64Bits(result.envelopeSpanMm)
          }
  })
}
addEnvelopeCase('empty', [])
for (const set of PIECE_SETS) {
  const { constructed } = runDecode(set.pieces, 'pure-growth', WIDE_SHEET, {})
  if (constructed !== undefined) {
    addEnvelopeCase(`${set.label}__placed`, constructed.state.placedCollisionGeometries)
  }
}

// =============================================================================
// Section C: checkpoint round-trip cases.
// =============================================================================
interface CheckpointCase {
  readonly caseLabel: string
  readonly candidateMode: string
  readonly pieces: ReturnType<typeof encodePreparedPiece>[]
  readonly finalSheetWidth: string
  readonly finalSheetHeight: string
  readonly maximumCompletedPieceBoundaries: string
  readonly capturePhaseTimings: boolean
  readonly checkpoint: ReturnType<typeof encodeCheckpoint>
  readonly pauseReason: string | null
  readonly uninterrupted: DecodedResult
}
const checkpointCases: CheckpointCase[] = []
for (const set of PIECE_SETS.filter((s) => s.pieces.length >= 2 && s.pieces.length <= 6)) {
  for (const capturePhaseTimings of [false, true]) {
    for (let boundary = 1; boundary < set.pieces.length; boundary += 1) {
      const { decoded: uninterrupted } = runDecode(set.pieces, 'pure-growth', WIDE_SHEET, {})
      const exit = runConstruct({
        allPreparedPieces: set.pieces,
        remainingPreparedPieces: set.pieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth',
        maximumRuntimeMs: 120_000,
        maximumCompletedPieceBoundaries: boundary,
        captureCandidateEvaluationCount: true,
        capturePhaseTimings,
        timingNow: makeClock()
      })
      if (exit._tag !== 'Success') {
        throw new Error(`unexpected checkpoint-stage failure for ${set.label} boundary ${boundary}`)
      }
      const checkpoint = exit.value.checkpoint
      if (checkpoint === undefined) {
        throw new Error(`expected a checkpoint for ${set.label} boundary ${boundary}`)
      }
      checkpointCases.push({
        caseLabel: `${set.label}__boundary-${boundary}__phaseTimings-${capturePhaseTimings}`,
        candidateMode: 'pure-growth',
        pieces: set.pieces.map(encodePreparedPiece),
        finalSheetWidth: f64Bits(WIDE_SHEET.width),
        finalSheetHeight: f64Bits(WIDE_SHEET.height),
        maximumCompletedPieceBoundaries: f64Bits(boundary),
        capturePhaseTimings,
        checkpoint: encodeCheckpoint(checkpoint),
        pauseReason: exit.value.pauseReason ?? null,
        uninterrupted
      })
    }
  }
}

// =============================================================================
// Section D: candidate-evaluation-cap truncation cases.
// =============================================================================
interface BudgetCapCase {
  readonly caseLabel: string
  readonly candidateMode: string
  readonly pieces: ReturnType<typeof encodePreparedPiece>[]
  readonly maximumCandidateEvaluationCount: string
  readonly truncationReason: string | null
  readonly candidateEvaluationCount: string | null
  readonly stepTraceLength: string
}
const budgetCapCases: BudgetCapCase[] = []
for (const set of PIECE_SETS.filter((s) => s.pieces.length >= 2)) {
  for (const mode of CANDIDATE_MODES) {
    for (const cap of [1, 2, 3, 5, 9]) {
      const { decoded } = runDecode(set.pieces, mode, WIDE_SHEET, {
        maximumCandidateEvaluationCount: cap
      })
      budgetCapCases.push({
        caseLabel: `${set.label}__${candidateModeLabel(mode)}__cap-${cap}`,
        candidateMode: candidateModeLabel(mode),
        pieces: set.pieces.map(encodePreparedPiece),
        maximumCandidateEvaluationCount: f64Bits(cap),
        truncationReason: decoded.truncationReason,
        candidateEvaluationCount: decoded.candidateEvaluationCount,
        stepTraceLength: f64Bits(decoded.stepTrace.length)
      })
    }
  }
}

// =============================================================================
// Section E: deadline-abort cases.
// =============================================================================
interface DeadlineCase {
  readonly caseLabel: string
  readonly candidateMode: string
  readonly pieces: ReturnType<typeof encodePreparedPiece>[]
  readonly maximumRuntimeMs: string
  readonly previousActiveRuntimeMs: string
  readonly expectFailure: boolean
  readonly reason: string | null
  readonly message: string | null
}
const deadlineCases: DeadlineCase[] = []
for (const set of PIECE_SETS.filter((s) => s.pieces.length >= 2)) {
  for (const mode of CANDIDATE_MODES) {
    for (const maximumRuntimeMs of [1, 2, 3]) {
      const timingNow = makeClock()
      const exit = runConstruct({
        allPreparedPieces: set.pieces,
        remainingPreparedPieces: set.pieces,
        frozenPlaced: [],
        candidateMode: mode,
        maximumRuntimeMs,
        captureCandidateEvaluationCount: true,
        timingNow
      })
      const isFailure = exit._tag === 'Failure'
      const detail = isFailure ? failureDetail(exit.cause) : undefined
      deadlineCases.push({
        caseLabel: `${set.label}__${candidateModeLabel(mode)}__deadline-${maximumRuntimeMs}`,
        candidateMode: candidateModeLabel(mode),
        pieces: set.pieces.map(encodePreparedPiece),
        maximumRuntimeMs: f64Bits(maximumRuntimeMs),
        previousActiveRuntimeMs: f64Bits(0),
        expectFailure: isFailure,
        reason: detail?.reason ?? null,
        message: detail?.message ?? null
      })
    }
  }
}
// One case with a nonzero previousActiveRuntimeMs fed through a real checkpoint,
// proving `previousActiveRuntimeMs + timingNow() - startedAt` accumulates exactly.
// `maximumRuntimeMs` must be **identical** across both stages (it is hashed into
// the checkpoint's own `requestFingerprint`, so a resumed call with a different
// value is rejected by `validateIntrinsicStrictDirectCheckpoint` before deadline
// logic ever runs) -- so this first probes stage 1's own elapsed
// `activeRuntimeMs` with a generous budget, then reruns stage 1 with a shared,
// tight budget just one tick above that elapsed amount (deterministic given the
// same clock/control flow, so the reprobe's `activeRuntimeMs` matches exactly),
// and resumes with that same shared budget, which must cross the deadline on
// the very first checkpoint of stage 2.
{
  const set = PIECE_SETS.find((s) => s.label === 'quad-0-5-10-15')
  if (set === undefined) throw new Error('expected quad-0-5-10-15 piece set')
  const probe = runConstruct({
    allPreparedPieces: set.pieces,
    remainingPreparedPieces: set.pieces,
    frozenPlaced: [],
    candidateMode: 'pure-growth',
    maximumRuntimeMs: 120_000,
    maximumCompletedPieceBoundaries: 1,
    captureCandidateEvaluationCount: true,
    timingNow: makeClock()
  })
  if (probe._tag !== 'Success' || probe.value.checkpoint === undefined) {
    throw new Error('expected a probe checkpoint for the previousActiveRuntimeMs deadline case')
  }
  const sharedMaximumRuntimeMs = probe.value.checkpoint.activeRuntimeMs + 1
  const stage1 = runConstruct({
    allPreparedPieces: set.pieces,
    remainingPreparedPieces: set.pieces,
    frozenPlaced: [],
    candidateMode: 'pure-growth',
    maximumRuntimeMs: sharedMaximumRuntimeMs,
    maximumCompletedPieceBoundaries: 1,
    captureCandidateEvaluationCount: true,
    timingNow: makeClock()
  })
  if (stage1._tag !== 'Success' || stage1.value.checkpoint === undefined) {
    throw new Error('expected a stage-1 checkpoint for the previousActiveRuntimeMs deadline case')
  }
  const checkpoint = stage1.value.checkpoint
  const timingNow2 = makeClock()
  const exit2 = runConstruct({
    allPreparedPieces: set.pieces,
    remainingPreparedPieces: set.pieces,
    frozenPlaced: [],
    candidateMode: 'pure-growth',
    maximumRuntimeMs: sharedMaximumRuntimeMs,
    captureCandidateEvaluationCount: true,
    checkpoint,
    timingNow: timingNow2
  })
  const isFailure = exit2._tag === 'Failure'
  const detail = isFailure ? failureDetail(exit2.cause) : undefined
  deadlineCases.push({
    caseLabel: 'quad-0-5-10-15__resumed-previous-runtime-deadline',
    candidateMode: 'pure-growth',
    pieces: set.pieces.map(encodePreparedPiece),
    maximumRuntimeMs: f64Bits(sharedMaximumRuntimeMs),
    previousActiveRuntimeMs: f64Bits(checkpoint.activeRuntimeMs),
    expectFailure: isFailure,
    reason: detail?.reason ?? null,
    message: detail?.message ?? null
  })
}

// =============================================================================
// Section F: Pareto/ranking cases over real completed-metrics pools.
// =============================================================================
interface ParetoCase {
  readonly caseLabel: string
  readonly pool: ReturnType<typeof encodeMetrics>[]
  readonly rankedHashes: string[]
  readonly frontHashes: string[]
  readonly dominanceMatrix: string[][]
  readonly dominatesMatrix: boolean[][]
}
const paretoCases: ParetoCase[] = []
function addParetoCase(caseLabel: string, pool: IntrinsicStrictCompletedMetrics[]): void {
  const ranked = rankIntrinsicStrictCompletedLayouts(pool)
  const front = selectIntrinsicStrictCompletedParetoFront(pool)
  const dominanceMatrix = pool.map((first) =>
    pool.map((second) => (compareIntrinsicStrictCompletedLayoutDominance(first, second) < 0 ? 'lt' : compareIntrinsicStrictCompletedLayoutDominance(first, second) > 0 ? 'gt' : 'eq'))
  )
  // `intrinsicStrictCompletedLayoutDominates` is exactly
  // `compareIntrinsicStrictCompletedLayoutDominance(...) < 0` -- called
  // directly (not merely re-derived from `dominanceMatrix` above) so the
  // Rust port's own wrapper function is itself under direct test.
  const dominatesMatrix = pool.map((first) =>
    pool.map((second) => intrinsicStrictCompletedLayoutDominates(first, second))
  )
  paretoCases.push({
    caseLabel,
    pool: pool.map(encodeMetrics),
    rankedHashes: ranked.map((m) => m.canonicalGeometryHash),
    frontHashes: front.map((m) => m.canonicalGeometryHash),
    dominanceMatrix,
    dominatesMatrix
  })
}

// Dedup by canonicalGeometryHash so pools contain genuinely distinct layouts.
const distinctMetricsByHash = new Map<string, IntrinsicStrictCompletedMetrics>()
for (const metrics of completedMetricsPool) {
  if (!distinctMetricsByHash.has(metrics.canonicalGeometryHash)) {
    distinctMetricsByHash.set(metrics.canonicalGeometryHash, metrics)
  }
}
const distinctMetrics = [...distinctMetricsByHash.values()]
if (distinctMetrics.length < 6) {
  throw new Error(`Expected >= 6 distinct completed layouts for Pareto pools, got ${distinctMetrics.length}.`)
}

for (let start = 0; start + 3 <= distinctMetrics.length; start += 1) {
  const pool = distinctMetrics.slice(start, start + Math.min(5, distinctMetrics.length - start))
  addParetoCase(`window-${start}`, pool)
}
// Shuffled-order variants of one pool, proving the peeling result is value-determined.
{
  const basePool = distinctMetrics.slice(0, Math.min(6, distinctMetrics.length))
  for (let rotation = 0; rotation < basePool.length; rotation += 1) {
    const rotated = [...basePool.slice(rotation), ...basePool.slice(0, rotation)]
    addParetoCase(`rotated-${rotation}`, rotated)
  }
  addParetoCase('reversed', [...basePool].reverse())
}
addParetoCase('full-pool', distinctMetrics)
addParetoCase('singleton', distinctMetrics.slice(0, 1))
addParetoCase('pair', distinctMetrics.slice(0, 2))

// ===========================================================================
// Vector-count accounting and write-out.
// ===========================================================================
const totalVectorCount =
  transformOrderCases.length +
  metricRoundingCases.length +
  decodeCases.length +
  envelopeCases.length +
  measureCompletedLayoutCases.length +
  checkpointCases.length +
  budgetCapCases.length +
  deadlineCases.length +
  paretoCases.length

if (totalVectorCount < 400) {
  throw new Error(`Expected >= 400 strict-decoder vectors, got ${totalVectorCount}.`)
}

mkdirSync(VECTORS_DIR, { recursive: true })
const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-strict-decoder.ts',
  generatingCommit: commit,
  description:
    'intrinsicStrictDecoder.ts full-port coverage: transformCandidateOrder stable-sort sweeps; ' +
    'canonicalLinearMetric/canonicalAreaMetric rounding sweeps (JS Math.round ties-toward-+Infinity ' +
    'hazard, including negative half-integers); measureIntrinsicStrictCanonicalEnvelope over real ' +
    'completed layouts; full constructIntrinsicStrictState+finalizeIntrinsicStrictState decode runs ' +
    'over real mixed61-hull piece sets (2-6 pieces, multi-transform including mirrored candidates) ' +
    'crossed with all four candidateMode values plus tiny-sheet infeasibility cases; checkpoint ' +
    'round-trip cases (every valid completed-piece-boundary, capturePhaseTimings on/off) recording ' +
    'the first-stage checkpoint hash-bearing fields for byte-exact reproduction plus the ' +
    'uninterrupted-run ground truth the resumed second stage must reach; deterministic ' +
    'candidate-evaluation-cap truncation cases; deterministic timingNow-seam deadline-abort cases ' +
    'including a resumed-checkpoint nonzero-previousActiveRuntimeMs case; and ' +
    'rankIntrinsicStrictCompletedLayouts/selectIntrinsicStrictCompletedParetoFront/' +
    'compareIntrinsicStrictCompletedLayoutDominance cases over real completed-metrics pools ' +
    '(windowed, rotated, and reversed input orders proving the peeling result is value-determined). ' +
    'f64 values are recorded as big-endian IEEE-754 bit-pattern hex strings for bit-exact comparison; ' +
    'BigInt-as-decimal-string grid fields are recorded verbatim. `settings` is a byte-exact JSON ' +
    'projection of the real production DEFAULT_IRREGULAR_NESTING_SETTINGS (GeometrySettings.Live), ' +
    'meant to be deserialized directly into the Rust IrregularNestingSettings via serde rather than ' +
    'hand-reconstructed, since the checkpoint request fingerprint hashes every field of it. The ' +
    'timingNow seam is a fresh incrementing counter starting at 1000 (+1 per call) constructed once ' +
    'per case; the Rust replay must construct an equivalent seam per case it replays.',
  clockStartValue: f64Bits(CLOCK_START_DOC_VALUE),
  clockIncrement: f64Bits(1),
  settings: NESTING_SETTINGS_JSON,
  transformOrderCaseCount: transformOrderCases.length,
  transformOrderCases,
  metricRoundingCaseCount: metricRoundingCases.length,
  metricRoundingCases,
  decodeCaseCount: decodeCases.length,
  decodeCases,
  envelopeCaseCount: envelopeCases.length,
  envelopeCases,
  measureCompletedLayoutCaseCount: measureCompletedLayoutCases.length,
  measureCompletedLayoutCases,
  checkpointCaseCount: checkpointCases.length,
  checkpointCases,
  budgetCapCaseCount: budgetCapCases.length,
  budgetCapCases,
  deadlineCaseCount: deadlineCases.length,
  deadlineCases,
  paretoCaseCount: paretoCases.length,
  paretoCases,
  totalVectorCount
}

writeFileSync(join(VECTORS_DIR, 'strict-decoder.json'), JSON.stringify(output, null, 2) + '\n')

console.log(
  `Wrote ${transformOrderCases.length} transform-order, ${metricRoundingCases.length} metric-rounding, ` +
    `${decodeCases.length} decode, ${envelopeCases.length} envelope, ` +
    `${measureCompletedLayoutCases.length} measure-completed-layout, ${checkpointCases.length} checkpoint, ` +
    `${budgetCapCases.length} budget-cap, ${deadlineCases.length} deadline, and ${paretoCases.length} ` +
    `pareto cases (${totalVectorCount} total vectors, commit ${commit}) to ${VECTORS_DIR}`
)
