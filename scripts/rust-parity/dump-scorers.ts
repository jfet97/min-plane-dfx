/**
 * Differential-vector generator for the Rust `search` module's scoring
 * cluster (`crates/irregular-nesting-native/src/search/{score_grid,
 * placement_scorer, layout_scorer, sort_pieces}.rs`).
 *
 * Imports the REAL production TS entry points --
 *   - `canonicalizeIrregularScoreMillimeters` /
 *     `canonicalizeIrregularScoreMillimeterUnits` /
 *     `canonicalizeIrregularScoreScalar`
 *     (`src/workers/algorithm/irregular/irregularScoreGrid.ts`),
 *   - `IrregularPlacementScorer.Layer` (`scoreCandidate`/`compare`, via the
 *     real DI-configured service, `src/workers/algorithm/irregular/irregularPlacementScorer.ts`),
 *   - `IrregularLayoutScorer.Live` (`scoreState`/`compare`, via the real
 *     DI-configured service composed with the real `FreeMaterialServiceLive`,
 *     `src/workers/algorithm/irregular/irregularLayoutScorer.ts`), exercised
 *     through real `IrregularBeamState` instances (`.empty()`/`.withPlacement`,
 *     `src/workers/algorithm/irregular/irregularBeamState.ts`) so the
 *     free-material cache's parent-fallback fast path is genuinely reached,
 *   - `sortPiecesForNesting` (`src/workers/algorithm/sortPiecesForNesting.ts`)
 * -- evaluates them over a broad deliberate input matrix (real mixed61
 * fixture-piece rings as collision polygons, every `IrregularPlacementPolicyId`,
 * varied sheets, 0-3 placed neighbors per placement candidate, 1-8-piece
 * incremental beam-state chains for the layout scorer, adjacent-pair
 * comparator outcomes for both scorers, and full 61-piece + tie-heavy
 * `sortPiecesForNesting` orderings), and writes byte-exact JSON vectors for
 * a Rust integration test to replay.
 *
 * Every case records **both** the raw input the TS function consumed (`f64`
 * fields as big-endian IEEE-754 bit-pattern hex strings, per
 * `dump-predicates.ts`'s `f64Bits` convention) **and** the resulting
 * output/error, so the Rust test can feed the identical input through its
 * own port and assert exact equality -- not just replay a pre-rendered
 * value.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-scorers.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/scorers.json
 */
import { Effect, Exit, Layer, Option } from 'effect'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PieceId } from '../../src/shared/domain/ids.js'
import { Rect, RectWith } from '../../src/shared/domain/geometry.js'
import { PreparedPiece, SheetSpec } from '../../src/shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransform,
  IrregularTransformCandidate,
  type IrregularPlacementPolicyId,
  type IrregularTransformReason,
  TransformedCollisionGeometry
} from '../../src/shared/irregular/domain.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  DEFAULT_IRREGULAR_NESTING_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '../../src/shared/irregular/defaults.js'
import type { IrregularNestingSettings } from '../../src/shared/irregular/domain.js'
import { IrregularNestingSettings as IrregularNestingSettingsClass } from '../../src/shared/irregular/domain.js'
import { GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { IrregularBeamState } from '../../src/workers/algorithm/irregular/irregularBeamState.js'
import {
  canonicalizeIrregularScoreMillimeters,
  canonicalizeIrregularScoreMillimeterUnits,
  canonicalizeIrregularScoreScalar
} from '../../src/workers/algorithm/irregular/irregularScoreGrid.js'
import {
  type IrregularPlacementScore,
  IrregularPlacementScorer,
  type ScoreIrregularPlacementCandidateInput
} from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import {
  type IrregularLayoutScore,
  IrregularLayoutScorer,
  type ScoreIrregularLayoutInput
} from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { sortPiecesForNesting } from '../../src/workers/algorithm/sortPiecesForNesting.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const VECTORS_DIR = join(REPO_ROOT, 'crates', 'irregular-nesting-native', 'tests', 'vectors')
const MIXED61_FIXTURE = join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'irregularSheetInvariance',
  'mixed61-request.json'
)

function generatingCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim()
}

// ---------------------------------------------------------------------------
// f64 -> exact big-endian IEEE-754 bit-pattern hex string (matches
// `dump-cache-keys.ts`'s/`dump-free-material.ts`'s `f64Bits` convention).
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
function bitsOrNull(value: number | undefined): string | null {
  return value === undefined ? null : f64Bits(value)
}

// ---------------------------------------------------------------------------
// Real mixed61 fixture-piece rings and real bounds (matches
// `dump-cache-keys.ts`'s `fixtureRing`/`fixtureLabel` precedent: this
// script's collision geometry uses each fixture piece's raw
// segment-start-point ring directly, the same simplification already used
// there, since exact convexity is irrelevant to exercising this cluster's
// pure scoring arithmetic byte-exactly).
// ---------------------------------------------------------------------------
interface FixtureLineSegment {
  readonly kind: string
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}
interface FixtureRealBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}
interface FixturePiece {
  readonly label: string
  readonly realBounds: FixtureRealBounds
  readonly geometry: { readonly segments: ReadonlyArray<FixtureLineSegment> }
}
interface Mixed61Fixture {
  readonly sourcePieces: ReadonlyArray<FixturePiece>
}

const mixed61Fixture: Mixed61Fixture = JSON.parse(readFileSync(MIXED61_FIXTURE, 'utf8'))
if (mixed61Fixture.sourcePieces.length !== 61) {
  throw new Error(
    `Expected 61 source pieces in the mixed61 fixture, got ${mixed61Fixture.sourcePieces.length}.`
  )
}
function fixturePiece(index: number): FixturePiece {
  const piece = mixed61Fixture.sourcePieces[index % mixed61Fixture.sourcePieces.length]
  if (piece === undefined) throw new Error('fixture piece index out of range')
  return piece
}
function fixtureRingPoints(index: number): IrregularPoint[] {
  return fixturePiece(index).geometry.segments.map(
    (segment) => new IrregularPoint({ x: segment.x1, y: segment.y1 })
  )
}
function fixtureLabel(index: number): string {
  return fixturePiece(index).label
}

// ---------------------------------------------------------------------------
// Encoding helpers.
// ---------------------------------------------------------------------------
function encodePoint(p: IrregularPoint) {
  return { x: f64Bits(p.x), y: f64Bits(p.y) }
}
function encodePoints(points: ReadonlyArray<IrregularPoint>) {
  return points.map(encodePoint)
}
function boundsOf(points: ReadonlyArray<IrregularPoint>) {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}
function encodeTransformCandidate(t: IrregularTransformCandidate) {
  return {
    index: f64Bits(t.index),
    rotationDeg: f64Bits(t.rotationDeg),
    mirrored: t.mirrored,
    reason: t.reason
  }
}
function encodeSheet(sheet: SheetSpec) {
  return { width: f64Bits(sheet.width), height: f64Bits(sheet.height), label: sheet.label }
}

// ---------------------------------------------------------------------------
// Settings variants -- real production defaults plus the two other named
// local policies, all via the real `makeCompactQualityIrregularOptimizerSettings`
// override mechanism (`src/shared/irregular/defaults.ts`).
// ---------------------------------------------------------------------------
function nestingSettingsWithPolicy(policyId: IrregularPlacementPolicyId): IrregularNestingSettings {
  return new IrregularNestingSettingsClass({
    geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
    optimizer: makeCompactQualityIrregularOptimizerSettings({ placementPolicyId: policyId })
  })
}
const EDGE_CONTACT_SETTINGS = DEFAULT_IRREGULAR_NESTING_SETTINGS
const BALANCED_SETTINGS = nestingSettingsWithPolicy('balanced-compactness')
const SHORT_SIDE_FILL_SETTINGS = nestingSettingsWithPolicy('short-side-fill')

// ---------------------------------------------------------------------------
// Resolve the real DI-configured services once per settings variant (via
// `.Layer`/`.Live`, per this task's instructions), reusing the resolved
// object across many calls so `IrregularLayoutScorer`'s closure-captured
// free-material cache is genuinely job-shared, exactly like one production
// job's single `IrregularLayoutScorer.Live` resolution.
// ---------------------------------------------------------------------------
function resolvePlacementScorer(settings: IrregularNestingSettings): IrregularPlacementScorer.Service {
  return Effect.runSync(
    Effect.gen(function* () {
      return yield* IrregularPlacementScorer
    }).pipe(
      Effect.provide(IrregularPlacementScorer.Layer),
      Effect.provide(Layer.succeed(GeometrySettings, settings))
    )
  )
}
function resolveLayoutScorer(settings: IrregularNestingSettings): IrregularLayoutScorer.Service {
  return Effect.runSync(
    Effect.gen(function* () {
      return yield* IrregularLayoutScorer
    }).pipe(
      Effect.provide(IrregularLayoutScorer.Live),
      Effect.provide(Layer.succeed(GeometrySettings, settings))
    )
  )
}

// ===========================================================================
// Section A: `irregularScoreGrid.ts`'s three canonicalization functions,
// called directly over an adversarial matrix.
// ===========================================================================
interface ScoreGridCase {
  readonly category: string
  readonly input: string
  readonly millimeters: string | null
  readonly millimeterUnits: string | null
  readonly scalar: string | null
}
const scoreGridCases: ScoreGridCase[] = []

const SCORE_GRID_INPUTS: ReadonlyArray<[string, number]> = [
  ['zero', 0],
  ['negative-zero', -0],
  ['one', 1],
  ['negative-one', -1],
  ['half', 0.5],
  ['negative-half', -0.5],
  ['halfway-mm-grid-positive', 0.0005],
  ['halfway-mm-grid-negative', -0.0005],
  ['past-halfway-mm-grid-positive', 0.0015],
  ['past-halfway-mm-grid-negative', -0.0015],
  ['just-below-halfway-mm-grid', 0.00049999999999],
  ['ordinary-mm', 1.2345],
  ['ordinary-mm-negative', -1.2345],
  ['large-finite-mm', 123456.789],
  ['large-finite-mm-negative', -123456.789],
  ['nan', Number.NaN],
  ['positive-infinity', Number.POSITIVE_INFINITY],
  ['negative-infinity', Number.NEGATIVE_INFINITY],
  ['exactly-max-safe-integer-grid-mm', Number.MAX_SAFE_INTEGER / 1000],
  ['just-past-max-safe-integer-grid-mm', Number.MAX_SAFE_INTEGER / 1000 + 10],
  ['exactly-max-safe-integer-scalar-grid', Number.MAX_SAFE_INTEGER / 1_000_000],
  ['just-past-max-safe-integer-scalar-grid', Number.MAX_SAFE_INTEGER / 1_000_000 + 10],
  ['very-large-finite', 9e12],
  ['very-large-finite-negative', -9e12],
  ['overflow-scale-huge', 1e300],
  ['overflow-scale-huge-negative', -1e300],
  ['tiny-subnormal-scale', 1e-10],
  ['tiny-subnormal-scale-negative', -1e-10],
  ['scalar-halfway-positive', 0.1234565],
  ['scalar-halfway-negative', -0.1234565],
  ['scalar-past-halfway', 0.1234575],
  ['ordinary-scalar', 0.999999],
  ['near-integer-boundary-scalar', 0.9999995],
  ['near-integer-boundary-scalar-below', 0.9999994999],
  ['grid-unit-boundary-just-below', 100.0004999999999],
  ['grid-unit-boundary-just-at', 100.0005],
  ['fractional-non-terminating', 1 / 3],
  ['fractional-non-terminating-negative', -1 / 3],
  ['max-value', Number.MAX_VALUE],
  ['min-value', Number.MIN_VALUE],
  ['sheet-scale-mm', 2700],
  ['sheet-scale-mm-negative', -2700]
]

for (const [category, value] of SCORE_GRID_INPUTS) {
  scoreGridCases.push({
    category,
    input: f64Bits(value),
    millimeters: bitsOrNull(canonicalizeIrregularScoreMillimeters(value)),
    millimeterUnits: bitsOrNull(canonicalizeIrregularScoreMillimeterUnits(value)),
    scalar: bitsOrNull(canonicalizeIrregularScoreScalar(value))
  })
}

// ===========================================================================
// Section B: `IrregularPlacementScorer.Layer.scoreCandidate` over a
// deliberate candidate matrix, plus explicit error-path cases.
// ===========================================================================
interface EncodedPlacementScore {
  readonly policyId: string
  readonly usedClusterMaxSideMm: string
  readonly worstNormalizedSheetConsumption: string
  readonly normalizedSheetSpanSum: string
  readonly usedClusterAreaMm2: string
  readonly usedClusterSpanMm: string
  readonly shortSideFill: string
  readonly longSideFill: string
  readonly sharedCollisionBoundaryLengthMm: string
  readonly candidateBottomMm: string
  readonly candidateLeftMm: string
  /** The score's retained `candidate` field, needed to reconstruct a full
   * `IrregularPlacementScore` for comparator testing (`deterministicLocalTieBreakOrder`
   * reads `candidate.transform.*`/`candidate.pieceId`, not just the eleven
   * numeric/policy fields above). */
  readonly candidatePieceId: string
  readonly candidateTransform: ReturnType<typeof encodeTransformCandidate>
}
function encodePlacementScore(score: IrregularPlacementScore): EncodedPlacementScore {
  return {
    policyId: score.policyId,
    usedClusterMaxSideMm: f64Bits(score.usedClusterMaxSideMm),
    worstNormalizedSheetConsumption: f64Bits(score.worstNormalizedSheetConsumption),
    normalizedSheetSpanSum: f64Bits(score.normalizedSheetSpanSum),
    usedClusterAreaMm2: f64Bits(score.usedClusterAreaMm2),
    usedClusterSpanMm: f64Bits(score.usedClusterSpanMm),
    shortSideFill: f64Bits(score.shortSideFill),
    longSideFill: f64Bits(score.longSideFill),
    sharedCollisionBoundaryLengthMm: f64Bits(score.sharedCollisionBoundaryLengthMm),
    candidateBottomMm: f64Bits(score.candidateBottomMm),
    candidateLeftMm: f64Bits(score.candidateLeftMm),
    candidatePieceId: score.candidate.pieceId,
    candidateTransform: encodeTransformCandidate(score.candidate.transform)
  }
}

interface EncodedPlacedPieceInput {
  readonly pieceId: string
  readonly points: ReturnType<typeof encodePoints>
  readonly translateX: string
  readonly translateY: string
}
function encodePlacedPieceInput(piece: IrregularPlacedPiece): EncodedPlacedPieceInput {
  return {
    pieceId: piece.placement.sourcePieceId,
    points: encodePoints(piece.collisionGeometry.polygon.points),
    translateX: f64Bits(piece.placement.transform.translateX),
    translateY: f64Bits(piece.placement.transform.translateY)
  }
}

interface PlacementScorerCase {
  readonly category: string
  readonly sheet: ReturnType<typeof encodeSheet>
  readonly placed: EncodedPlacedPieceInput[]
  readonly movingPieceId: string
  readonly movingTransform: ReturnType<typeof encodeTransformCandidate>
  readonly movingPoints: ReturnType<typeof encodePoints>
  readonly candidatePieceId: string
  readonly candidateTransform: ReturnType<typeof encodeTransformCandidate>
  readonly candidatePoint: ReturnType<typeof encodePoint>
  readonly requestedPolicyId: string | null
  readonly ok: boolean
  readonly score?: EncodedPlacementScore
  readonly operation?: string
  readonly message?: string
}
const placementScorerCases: PlacementScorerCase[] = []

function placedFrom(
  pieceId: string,
  points: ReadonlyArray<IrregularPoint>,
  translateX: number,
  translateY: number
): IrregularPlacedPiece {
  const id = PieceId.make(pieceId)
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: id,
      transform: new IrregularTransform({ translateX, translateY, rotationDeg: 0, mirrored: false })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: id,
      transform: new IrregularTransformCandidate({
        index: 0,
        rotationDeg: 0,
        mirrored: false,
        reason: 'configured'
      }),
      polygon: new IrregularPolygon({ points }),
      bounds: boundsOf(points)
    })
  })
}

function runPlacementScorerCase(
  category: string,
  settings: IrregularNestingSettings,
  requestedPolicyId: IrregularPlacementPolicyId | undefined,
  sheet: SheetSpec,
  placed: ReadonlyArray<IrregularPlacedPiece>,
  movingPieceId: string,
  movingTransform: IrregularTransformCandidate,
  movingPoints: ReadonlyArray<IrregularPoint>,
  candidatePieceId: string,
  candidateTransform: IrregularTransformCandidate,
  candidateX: number,
  candidateY: number
): void {
  const movingId = PieceId.make(movingPieceId)
  const moving = new TransformedCollisionGeometry({
    sourcePieceId: movingId,
    transform: movingTransform,
    polygon: new IrregularPolygon({ points: movingPoints }),
    bounds: boundsOf(movingPoints)
  })
  const candidate = new IrregularPlacementCandidate({
    pieceId: PieceId.make(candidatePieceId),
    transform: candidateTransform,
    point: new IrregularPoint({ x: candidateX, y: candidateY }),
    diagnostics: []
  })
  const input: ScoreIrregularPlacementCandidateInput = {
    sheet,
    placed,
    moving,
    candidate,
    ...(requestedPolicyId !== undefined ? { policyId: requestedPolicyId } : {})
  }

  const scorer = resolvePlacementScorer(settings)
  const exit = Effect.runSyncExit(scorer.scoreCandidate(input))

  const base = {
    category,
    sheet: encodeSheet(sheet),
    placed: placed.map(encodePlacedPieceInput),
    movingPieceId: moving.sourcePieceId,
    movingTransform: encodeTransformCandidate(movingTransform),
    movingPoints: encodePoints(movingPoints),
    candidatePieceId: candidate.pieceId,
    candidateTransform: encodeTransformCandidate(candidateTransform),
    candidatePoint: encodePoint(candidate.point),
    requestedPolicyId: requestedPolicyId ?? null
  }

  if (Exit.isSuccess(exit)) {
    placementScorerCases.push({ ...base, ok: true, score: encodePlacementScore(exit.value) })
    return
  }
  const failure = Exit.findErrorOption(exit)
  if (Option.isNone(failure)) {
    throw new Error(`unexpected non-Fail scoreCandidate exit for ${category}: ${JSON.stringify(exit)}`)
  }
  placementScorerCases.push({
    ...base,
    ok: false,
    operation: failure.value.operation,
    message: failure.value.message
  })
}

const REASONS: ReadonlyArray<IrregularTransformReason> = ['orthogonal', 'edge_alignment', 'configured']
const SHEET_VARIANTS: ReadonlyArray<[string, SheetSpec]> = [
  ['default-1x1m', new SheetSpec({ width: 2000, height: 2700, label: 'default 1x1 m' })],
  ['square', new SheetSpec({ width: 1500, height: 1500, label: 'square sheet' })],
  ['small', new SheetSpec({ width: 500, height: 400, label: 'small sheet' })]
]
const POLICY_VARIANTS: ReadonlyArray<IrregularPlacementPolicyId | undefined> = [
  undefined,
  'balanced-compactness',
  'short-side-fill',
  'edge-contact-then-balanced-compactness'
]

{
  const movingIndices = [0, 8, 16, 24, 32, 40, 48, 56]
  const placedSetVariants: ReadonlyArray<[string, ReadonlyArray<IrregularPlacedPiece>]> = [
    ['no-neighbors', []],
    [
      'one-touching-neighbor',
      [placedFrom('neighbor-1', fixtureRingPoints(1), 200, 0)]
    ],
    [
      'two-neighbors-mixed-distance',
      [
        placedFrom('neighbor-2', fixtureRingPoints(2), 150, 0),
        placedFrom('neighbor-3', fixtureRingPoints(3), 0, 300)
      ]
    ]
  ]

  for (const movingIndex of movingIndices) {
    const movingPoints = fixtureRingPoints(movingIndex)
    const movingTransform = new IrregularTransformCandidate({
      index: movingIndex % 4,
      rotationDeg: (movingIndex * 23) % 360,
      mirrored: movingIndex % 3 === 0,
      reason: REASONS[movingIndex % 3] as IrregularTransformReason
    })
    for (const [sheetLabel, sheet] of SHEET_VARIANTS) {
      for (const [placedLabel, placed] of placedSetVariants) {
        for (const policyId of POLICY_VARIANTS) {
          runPlacementScorerCase(
            `moving=${fixtureLabel(movingIndex)}:sheet=${sheetLabel}:placed=${placedLabel}:policy=${policyId ?? 'default'}`,
            EDGE_CONTACT_SETTINGS,
            policyId,
            sheet,
            placed,
            `moving-${movingIndex}`,
            movingTransform,
            movingPoints,
            `moving-${movingIndex}`,
            movingTransform,
            10 + movingIndex,
            5 + movingIndex
          )
        }
      }
    }
  }

  // Error path: candidate piece id does not match the moving geometry's
  // source piece id -- `validateCandidateMetadata`'s first check.
  runPlacementScorerCase(
    'error:mismatched-piece-id',
    EDGE_CONTACT_SETTINGS,
    undefined,
    SHEET_VARIANTS[0]![1],
    [],
    'moving-piece',
    new IrregularTransformCandidate({ index: 0, rotationDeg: 0, mirrored: false, reason: 'configured' }),
    fixtureRingPoints(5),
    'different-candidate-piece',
    new IrregularTransformCandidate({ index: 0, rotationDeg: 0, mirrored: false, reason: 'configured' }),
    0,
    0
  )

  // Error path: candidate transform metadata does not match the moving
  // geometry's transform -- `validateCandidateMetadata`'s second check.
  runPlacementScorerCase(
    'error:mismatched-transform',
    EDGE_CONTACT_SETTINGS,
    undefined,
    SHEET_VARIANTS[0]![1],
    [],
    'moving-piece',
    new IrregularTransformCandidate({ index: 0, rotationDeg: 0, mirrored: false, reason: 'configured' }),
    fixtureRingPoints(5),
    'moving-piece',
    new IrregularTransformCandidate({ index: 1, rotationDeg: 90, mirrored: true, reason: 'orthogonal' }),
    0,
    0
  )

  // Error path: non-finite candidate point -- `makeCombinedBounds` returns
  // `undefined` via `translatePolygonWithBounds`'s finiteness guard.
  runPlacementScorerCase(
    'error:non-finite-candidate-point',
    EDGE_CONTACT_SETTINGS,
    undefined,
    SHEET_VARIANTS[0]![1],
    [],
    'moving-piece',
    new IrregularTransformCandidate({ index: 0, rotationDeg: 0, mirrored: false, reason: 'configured' }),
    fixtureRingPoints(5),
    'moving-piece',
    new IrregularTransformCandidate({ index: 0, rotationDeg: 0, mirrored: false, reason: 'configured' }),
    Number.POSITIVE_INFINITY,
    0
  )

  // Square sheet forces `balanced-compactness` regardless of requested
  // policy -- explicit case per policy id (mirrors the Rust unit test, at
  // vector granularity across every requested policy).
  for (const policyId of POLICY_VARIANTS) {
    runPlacementScorerCase(
      `square-sheet-forces-balanced-compactness:requested=${policyId ?? 'default'}`,
      EDGE_CONTACT_SETTINGS,
      policyId,
      new SheetSpec({ width: 1200, height: 1200, label: 'square' }),
      [],
      'moving-piece',
      new IrregularTransformCandidate({ index: 0, rotationDeg: 0, mirrored: false, reason: 'configured' }),
      fixtureRingPoints(7),
      'moving-piece',
      new IrregularTransformCandidate({ index: 0, rotationDeg: 0, mirrored: false, reason: 'configured' }),
      50,
      50
    )
  }
}

// ===========================================================================
// Section C: `IrregularPlacementScorer.Layer.compare` adjacent-pair
// comparator outcomes, one settings/policy variant per named policy.
// ===========================================================================
interface PlacementComparatorCase {
  readonly category: string
  readonly policyId: string
  readonly firstIndex: number
  readonly secondIndex: number
  readonly first: EncodedPlacementScore
  readonly second: EncodedPlacementScore
  readonly compareFirstSecond: number
  readonly compareSecondFirst: number
}
const placementComparatorCases: PlacementComparatorCase[] = []

{
  const settingsByPolicy: ReadonlyArray<[IrregularPlacementPolicyId, IrregularNestingSettings]> = [
    ['balanced-compactness', BALANCED_SETTINGS],
    ['short-side-fill', SHORT_SIDE_FILL_SETTINGS],
    ['edge-contact-then-balanced-compactness', EDGE_CONTACT_SETTINGS]
  ]
  const sheet = new SheetSpec({ width: 2000, height: 2700, label: 'default 1x1 m' })

  for (const [policyId, settings] of settingsByPolicy) {
    const scorer = resolvePlacementScorer(settings)
    const scores: IrregularPlacementScore[] = []
    for (let index = 0; index < 12; index += 1) {
      const movingPoints = fixtureRingPoints(index)
      const movingId = PieceId.make(`compare-piece-${index}`)
      const transform = new IrregularTransformCandidate({
        index: index % 4,
        rotationDeg: (index * 41) % 360,
        mirrored: index % 2 === 0,
        reason: REASONS[index % 3] as IrregularTransformReason
      })
      const moving = new TransformedCollisionGeometry({
        sourcePieceId: movingId,
        transform,
        polygon: new IrregularPolygon({ points: movingPoints }),
        bounds: boundsOf(movingPoints)
      })
      const candidate = new IrregularPlacementCandidate({
        pieceId: movingId,
        transform,
        point: new IrregularPoint({ x: index * 15, y: (index * 7) % 40 }),
        diagnostics: []
      })
      const placed = index === 0 ? [] : [placedFrom(`neighbor-${index}`, fixtureRingPoints(index + 20), index * 5, 0)]
      const input: ScoreIrregularPlacementCandidateInput = { sheet, placed, moving, candidate, policyId }
      const exit = Effect.runSyncExit(scorer.scoreCandidate(input))
      if (Exit.isFailure(exit)) {
        throw new Error(`unexpected scoreCandidate failure building comparator batch: ${JSON.stringify(exit.cause)}`)
      }
      scores.push(exit.value)
    }

    for (let i = 0; i + 1 < scores.length; i += 1) {
      const first = scores[i]!
      const second = scores[i + 1]!
      placementComparatorCases.push({
        category: `policy=${policyId}:adjacent-pair:${i}`,
        policyId,
        firstIndex: i,
        secondIndex: i + 1,
        first: encodePlacementScore(first),
        second: encodePlacementScore(second),
        compareFirstSecond: scorer.compare(first, second),
        compareSecondFirst: scorer.compare(second, first)
      })
    }
  }
}

// ===========================================================================
// Section D: `IrregularLayoutScorer.Live.scoreState` over incremental
// `IrregularBeamState` chains (real `.empty()`/`.withPlacement`), so the
// free-material cache's parent-fallback fast path is genuinely exercised.
// ===========================================================================
interface EncodedLayoutScore {
  readonly unplacedCount: string
  readonly sharedCollisionBoundaryLengthMm: string
  readonly sharedCollisionBoundaryContactUnits: string
  readonly sharedCollisionBoundaryContactBand: string
  readonly nearCompleteStructuralContactCount: string
  readonly dominantNearCompleteStructuralContactCount: string
  readonly largestNetFreeMaterialRegionAreaMm2: string
  readonly freeMaterialRegionCount: string
  readonly freeMaterialHoleCount: string
  readonly freeMaterialSliverMetric: string
  readonly collisionBoundsWorstNormalizedSheetConsumption: string
  readonly collisionBoundsNormalizedSpanSum: string
  readonly collisionBoundsAreaMm2: string
  readonly collisionBoundsSpanMm: string
  readonly occupiedHullWasteRatio: string
  readonly collisionBoundsBottomMm: string
  readonly collisionBoundsLeftMm: string
  readonly placementOrder: ReadonlyArray<string>
  readonly unplacedSourcePieceIds: ReadonlyArray<string>
}
function encodeLayoutScore(score: IrregularLayoutScore): EncodedLayoutScore {
  return {
    unplacedCount: f64Bits(score.unplacedCount),
    sharedCollisionBoundaryLengthMm: f64Bits(score.sharedCollisionBoundaryLengthMm),
    sharedCollisionBoundaryContactUnits: f64Bits(score.sharedCollisionBoundaryContactUnits),
    sharedCollisionBoundaryContactBand: f64Bits(score.sharedCollisionBoundaryContactBand),
    nearCompleteStructuralContactCount: f64Bits(score.nearCompleteStructuralContactCount),
    dominantNearCompleteStructuralContactCount: f64Bits(
      score.dominantNearCompleteStructuralContactCount
    ),
    largestNetFreeMaterialRegionAreaMm2: f64Bits(score.largestNetFreeMaterialRegionAreaMm2),
    freeMaterialRegionCount: f64Bits(score.freeMaterialRegionCount),
    freeMaterialHoleCount: f64Bits(score.freeMaterialHoleCount),
    freeMaterialSliverMetric: f64Bits(score.freeMaterialSliverMetric),
    collisionBoundsWorstNormalizedSheetConsumption: f64Bits(
      score.collisionBoundsWorstNormalizedSheetConsumption
    ),
    collisionBoundsNormalizedSpanSum: f64Bits(score.collisionBoundsNormalizedSpanSum),
    collisionBoundsAreaMm2: f64Bits(score.collisionBoundsAreaMm2),
    collisionBoundsSpanMm: f64Bits(score.collisionBoundsSpanMm),
    occupiedHullWasteRatio: f64Bits(score.occupiedHullWasteRatio),
    collisionBoundsBottomMm: f64Bits(score.collisionBoundsBottomMm),
    collisionBoundsLeftMm: f64Bits(score.collisionBoundsLeftMm),
    placementOrder: score.placementOrder,
    unplacedSourcePieceIds: score.unplacedSourcePieceIds
  }
}

interface EncodedCollisionBounds {
  readonly minX: string
  readonly minY: string
  readonly maxX: string
  readonly maxY: string
  readonly width: string
  readonly height: string
}
interface EncodedBeamStateInput {
  readonly placed: EncodedPlacedPieceInput[]
  readonly translatedCollisionBounds: EncodedCollisionBounds | null
  readonly sharedCollisionBoundaryLengthMm: string | null
  readonly sharedCollisionBoundaryContactUnits: string | null
  readonly nearCompleteStructuralContactCount: string | null
  readonly dominantNearCompleteStructuralContactCount: string | null
  readonly canonicalOccupiedGeometryKey: string
  readonly placementOrder: ReadonlyArray<string>
  readonly unplacedSourcePieceIds: ReadonlyArray<string>
}
/**
 * Encodes every field `search::layout_scorer::LayoutScorerBeamStateView`
 * (the Rust seam type standing in for the not-yet-landed
 * `search::beam_state::IrregularBeamState`) needs, read directly off the
 * real `IrregularBeamState` instance -- these derived fields
 * (`translatedCollisionBounds`, `sharedCollisionBoundaryLengthMm`, etc.) are
 * exactly the "raw input" this cluster's Rust port receives from that seam,
 * so recording them here (not re-deriving them some other way) is what lets
 * the Rust test replay `score_derived_state` against the identical input the
 * TS `scoreDerivedState` call actually saw.
 */
function encodeBeamStateInput(state: IrregularBeamState): EncodedBeamStateInput {
  const bounds = state.translatedCollisionBounds
  return {
    placed: state.placedCollisionGeometries.map(encodePlacedPieceInput),
    translatedCollisionBounds:
      bounds === undefined
        ? null
        : {
            minX: f64Bits(bounds.minX),
            minY: f64Bits(bounds.minY),
            maxX: f64Bits(bounds.maxX),
            maxY: f64Bits(bounds.maxY),
            width: f64Bits(bounds.width),
            height: f64Bits(bounds.height)
          },
    sharedCollisionBoundaryLengthMm: bitsOrNull(state.sharedCollisionBoundaryLengthMm),
    sharedCollisionBoundaryContactUnits: bitsOrNull(state.sharedCollisionBoundaryContactUnits),
    nearCompleteStructuralContactCount: bitsOrNull(state.nearCompleteStructuralContactCount),
    dominantNearCompleteStructuralContactCount: bitsOrNull(
      state.dominantNearCompleteStructuralContactCount
    ),
    canonicalOccupiedGeometryKey: state.canonicalOccupiedGeometryKey,
    placementOrder: state.placementOrder,
    unplacedSourcePieceIds: state.unplacedSourcePieceIds
  }
}

interface LayoutScorerCase {
  readonly category: string
  readonly sheet: ReturnType<typeof encodeSheet>
  readonly state: EncodedBeamStateInput
  readonly ok: boolean
  readonly score?: EncodedLayoutScore
  readonly operation?: string
  readonly message?: string
}
const layoutScorerCases: LayoutScorerCase[] = []

// `IrregularLayoutScorer.scoreState` reaches `computeFreeMaterial`, whose
// Clipper2 offset step validates that every placed collision polygon is
// strictly convex with one consistent winding -- unlike sections B/C's
// `scoreCandidate` cases, raw fixture-piece rings (not guaranteed convex)
// cannot be used here. This helper instead builds an axis-aligned rectangle
// sized from a real fixture piece's `realBounds` (still real-fixture-derived
// dimensions, just convex by construction).
function rectanglePoints(width: number, height: number): IrregularPoint[] {
  return [
    new IrregularPoint({ x: 0, y: 0 }),
    new IrregularPoint({ x: width, y: 0 }),
    new IrregularPoint({ x: width, y: height }),
    new IrregularPoint({ x: 0, y: height })
  ]
}

function beamPlacedPiece(index: number, translateX: number, translateY: number): IrregularPlacedPiece {
  const id = PieceId.make(`beam-piece-${index}`)
  const bounds = fixturePiece(index).realBounds
  const points = rectanglePoints(bounds.width, bounds.height)
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: id,
      transform: new IrregularTransform({ translateX, translateY, rotationDeg: 0, mirrored: false })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: id,
      transform: new IrregularTransformCandidate({
        index: 0,
        rotationDeg: 0,
        mirrored: false,
        reason: 'configured'
      }),
      polygon: new IrregularPolygon({ points }),
      bounds: boundsOf(points)
    })
  })
}

/**
 * Always resolves a **fresh** `IrregularLayoutScorer` (an empty
 * free-material cache, per `resolveLayoutScorer`) for every single case,
 * rather than reusing one scorer across a chain. This guarantees
 * `computeSnapshotWithParentFallback` always takes the `full()` code path on
 * the TS side too (no parent-snapshot cache hit is ever possible against a
 * cache that has never scored anything), matching exactly what the Rust
 * replay does (a fresh `FreeMaterialCache::new()` per test case, since this
 * dump script has no way to reconstruct the real `IrregularBeamState`
 * `.parent` chain in Rust without `search::beam_state`, a different,
 * not-yet-landed task's module -- see this module's top doc). This
 * sidesteps `search-scoring.md` §15 item 3/4's open
 * `extendFreeMaterial`-vs-`computeFreeMaterial` numeric-equivalence
 * question entirely rather than silently depending on it: every vector
 * below is a same-code-path, apples-to-apples comparison on both sides.
 */
function runLayoutScorerCase(
  category: string,
  settings: IrregularNestingSettings,
  sheet: SheetSpec,
  state: IrregularBeamState
): void {
  const scorer = resolveLayoutScorer(settings)
  const input: ScoreIrregularLayoutInput = { sheet, state }
  const exit = Effect.runSyncExit(scorer.scoreState(input))
  const base = {
    category,
    sheet: encodeSheet(sheet),
    state: encodeBeamStateInput(state)
  }
  if (Exit.isSuccess(exit)) {
    layoutScorerCases.push({ ...base, ok: true, score: encodeLayoutScore(exit.value) })
    return
  }
  const failure = Exit.findErrorOption(exit)
  if (Option.isNone(failure)) {
    throw new Error(`unexpected non-Fail scoreState exit for ${category}: ${JSON.stringify(exit.cause)}`)
  }
  const value = failure.value as { readonly operation: string; readonly message: string }
  layoutScorerCases.push({ ...base, ok: false, operation: value.operation, message: value.message })
}

{
  const sheet = new SheetSpec({ width: 2000, height: 2700, label: 'default 1x1 m' })

  // A beam-state chain built incrementally (real `.withPlacement`, one piece
  // at a time up to 8 pieces) and scored after every placement -- each call
  // resolves its own fresh scorer (see `runLayoutScorerCase`'s doc), so this
  // still exercises `scoreDerivedState` across steadily growing real
  // geometry without depending on the free-material cache's parent-fallback
  // path being numerically proven equivalent to the full path.
  let state = IrregularBeamState.empty([])
  for (let index = 0; index < 8; index += 1) {
    const placedPiece = beamPlacedPiece(index, index * 120, (index % 3) * 90)
    state = state.withPlacement({
      remainingPreparedPieces: [],
      placedCollisionGeometry: placedPiece,
      placementOrderPieceId: placedPiece.placement.sourcePieceId
    })
    runLayoutScorerCase(`incremental-chain:step=${index + 1}`, EDGE_CONTACT_SETTINGS, sheet, state)
  }

  // A second, independent chain over a disjoint piece-index range.
  let secondChainState = IrregularBeamState.empty([])
  for (let index = 30; index < 34; index += 1) {
    const placedPiece = beamPlacedPiece(index, index * 90, index * 10)
    secondChainState = secondChainState.withPlacement({
      remainingPreparedPieces: [],
      placedCollisionGeometry: placedPiece,
      placementOrderPieceId: placedPiece.placement.sourcePieceId
    })
    runLayoutScorerCase(`second-chain:step=${index - 29}`, EDGE_CONTACT_SETTINGS, sheet, secondChainState)
  }

  // Fresh (non-incremental, `parent: undefined`) reconstructions from a flat
  // `placedCollisionGeometries` array at 1/3/6 pieces -- matches how
  // production result-materialization always rebuilds a final state fresh
  // (`search-scoring.md` §1.2).
  for (const count of [1, 3, 6]) {
    const placed: IrregularPlacedPiece[] = []
    for (let index = 0; index < count; index += 1) {
      placed.push(beamPlacedPiece(40 + index, 40 + index * 100, index * 60))
    }
    const freshState = new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries: placed,
      unplacedSourcePieceIds: [PieceId.make('unplaced-1'), PieceId.make('unplaced-2')],
      placementOrder: placed.map((p) => p.placement.sourcePieceId)
    })
    runLayoutScorerCase(`fresh-reconstruction:count=${count}`, EDGE_CONTACT_SETTINGS, sheet, freshState)
  }

  // Unplaced-count variation at fixed placed geometry (dominance criterion).
  const dominancePlaced = [beamPlacedPiece(50, 0, 0)]
  for (const unplacedCount of [0, 1, 4]) {
    const unplacedIds = Array.from({ length: unplacedCount }, (_v, i) => PieceId.make(`dominance-unplaced-${i}`))
    const dominanceState = new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries: dominancePlaced,
      unplacedSourcePieceIds: unplacedIds,
      placementOrder: dominancePlaced.map((p) => p.placement.sourcePieceId)
    })
    runLayoutScorerCase(`unplaced-count=${unplacedCount}`, EDGE_CONTACT_SETTINGS, sheet, dominanceState)
  }

  // Square sheet and a small sheet, same 2-piece state, for
  // sheet-normalization coverage.
  for (const [label, altSheet] of [
    ['square', new SheetSpec({ width: 1500, height: 1500, label: 'square' })],
    ['small', new SheetSpec({ width: 500, height: 400, label: 'small' })]
  ] as ReadonlyArray<[string, SheetSpec]>) {
    const altPlaced = [beamPlacedPiece(55, 0, 0), beamPlacedPiece(56, 60, 0)]
    const altState = new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries: altPlaced,
      unplacedSourcePieceIds: [],
      placementOrder: altPlaced.map((p) => p.placement.sourcePieceId)
    })
    runLayoutScorerCase(`sheet=${label}`, EDGE_CONTACT_SETTINGS, altSheet, altState)
  }
}

// ===========================================================================
// Section E: `IrregularLayoutScorer.Live.compare` adjacent-pair comparator
// outcomes, at both the strict (<=20 placements) and scale-aware (>20,
// equal-depth) term orders.
// ===========================================================================
interface LayoutComparatorCase {
  readonly category: string
  readonly firstPlacedCount: number
  readonly secondPlacedCount: number
  readonly first: EncodedLayoutScore
  readonly second: EncodedLayoutScore
  readonly compareFirstSecond: number
  readonly compareSecondFirst: number
}
const layoutComparatorCases: LayoutComparatorCase[] = []

{
  const sheet = new SheetSpec({ width: 2000, height: 2700, label: 'default 1x1 m' })

  // Strict-order batch: a chain of states at depths 1..10 (<= the 20-piece
  // strict/scale-aware threshold), so every adjacent pair compares via
  // `strictLayoutScoreOrder`.
  {
    const scorer = resolveLayoutScorer(EDGE_CONTACT_SETTINGS)
    let state = IrregularBeamState.empty([])
    const scores: IrregularLayoutScore[] = []
    for (let index = 0; index < 10; index += 1) {
      const placedPiece = beamPlacedPiece(index, index * 110, (index % 4) * 70)
      state = state.withPlacement({
        remainingPreparedPieces: [],
        placedCollisionGeometry: placedPiece,
        placementOrderPieceId: placedPiece.placement.sourcePieceId
      })
      const exit = Effect.runSyncExit(scorer.scoreState({ sheet, state }))
      if (Exit.isFailure(exit)) {
        throw new Error(`unexpected scoreState failure building strict comparator batch: ${JSON.stringify(exit.cause)}`)
      }
      scores.push(exit.value)
    }
    for (let i = 0; i + 1 < scores.length; i += 1) {
      const first = scores[i]!
      const second = scores[i + 1]!
      layoutComparatorCases.push({
        category: `strict-order:adjacent-pair:${i}`,
        firstPlacedCount: first.placementOrder.length,
        secondPlacedCount: second.placementOrder.length,
        first: encodeLayoutScore(first),
        second: encodeLayoutScore(second),
        compareFirstSecond: scorer.compare(first, second),
        compareSecondFirst: scorer.compare(second, first)
      })
    }
  }

  // Scale-aware-order batch: two independent 25-piece states (both above the
  // 20-piece strict threshold, both the same depth), so their mutual compare
  // dispatches to `scaleAwareLayoutScoreOrder`.
  {
    const scorer = resolveLayoutScorer(EDGE_CONTACT_SETTINGS)
    function buildChain(startIndex: number, offsetX: number): IrregularLayoutScore {
      let state = IrregularBeamState.empty([])
      for (let step = 0; step < 25; step += 1) {
        const placedPiece = beamPlacedPiece(startIndex + step, offsetX + step * 95, (step % 5) * 55)
        state = state.withPlacement({
          remainingPreparedPieces: [],
          placedCollisionGeometry: placedPiece,
          placementOrderPieceId: placedPiece.placement.sourcePieceId
        })
      }
      const exit = Effect.runSyncExit(scorer.scoreState({ sheet, state }))
      if (Exit.isFailure(exit)) {
        throw new Error(`unexpected scoreState failure building scale-aware batch: ${JSON.stringify(exit.cause)}`)
      }
      return exit.value
    }
    const first = buildChain(0, 0)
    const second = buildChain(0, 17)
    layoutComparatorCases.push({
      category: 'scale-aware-order:equal-depth-pair',
      firstPlacedCount: first.placementOrder.length,
      secondPlacedCount: second.placementOrder.length,
      first: encodeLayoutScore(first),
      second: encodeLayoutScore(second),
      compareFirstSecond: scorer.compare(first, second),
      compareSecondFirst: scorer.compare(second, first)
    })

    // Unequal depth, both above the threshold -- must fall back to the
    // strict order despite both exceeding 20 placements (the dispatcher's
    // documented "falls back... even if both exceed 20" rule).
    const third = buildChain(0, 0)
    let shortState = IrregularBeamState.empty([])
    for (let step = 0; step < 22; step += 1) {
      const placedPiece = beamPlacedPiece(step, 200 + step * 95, (step % 5) * 55)
      shortState = shortState.withPlacement({
        remainingPreparedPieces: [],
        placedCollisionGeometry: placedPiece,
        placementOrderPieceId: placedPiece.placement.sourcePieceId
      })
    }
    const shortExit = Effect.runSyncExit(scorer.scoreState({ sheet, state: shortState }))
    if (Exit.isFailure(shortExit)) {
      throw new Error(`unexpected scoreState failure building unequal-depth case: ${JSON.stringify(shortExit.cause)}`)
    }
    const fourth = shortExit.value
    layoutComparatorCases.push({
      category: 'unequal-depth-both-above-threshold-uses-strict-order',
      firstPlacedCount: third.placementOrder.length,
      secondPlacedCount: fourth.placementOrder.length,
      first: encodeLayoutScore(third),
      second: encodeLayoutScore(fourth),
      compareFirstSecond: scorer.compare(third, fourth),
      compareSecondFirst: scorer.compare(fourth, third)
    })
  }
}

// ===========================================================================
// Section F: `sortPiecesForNesting` full output orders, including the real
// 61-piece fixture and deliberate tie-heavy synthetic sets.
// ===========================================================================
interface EncodedPreparedPiece {
  readonly id: string
  readonly longestEdge: string
  readonly area: string
  readonly imbalance: string
}
interface SortPiecesCase {
  readonly category: string
  readonly input: EncodedPreparedPiece[]
  readonly outputOrder: ReadonlyArray<string>
}
const sortPiecesCases: SortPiecesCase[] = []

function preparedPiece(id: string, width: number, height: number, padding = 0): PreparedPiece {
  const realBounds = new Rect({ x: 0, y: 0, width, height })
  const paddedBounds = RectWith.fromRect(realBounds)
  return new PreparedPiece({
    id: PieceId.make(id),
    sourcePieceId: PieceId.make(id),
    realBounds,
    paddedBounds,
    padding,
    allowRotation: true
  })
}
function encodePreparedPiece(piece: PreparedPiece): EncodedPreparedPiece {
  return {
    id: piece.id,
    longestEdge: f64Bits(piece.paddedBounds.longestEdge),
    area: f64Bits(piece.paddedBounds.area),
    imbalance: f64Bits(piece.paddedBounds.imbalance)
  }
}
function runSortPiecesCase(category: string, pieces: ReadonlyArray<PreparedPiece>): void {
  const sorted = sortPiecesForNesting(pieces)
  sortPiecesCases.push({
    category,
    input: pieces.map(encodePreparedPiece),
    outputOrder: sorted.map((p) => p.id)
  })
}

runSortPiecesCase('empty', [])
runSortPiecesCase('single-piece', [preparedPiece('solo', 100, 60)])
runSortPiecesCase('all-tied-preserves-original-order', [
  preparedPiece('a', 100, 60),
  preparedPiece('b', 100, 60),
  preparedPiece('c', 100, 60),
  preparedPiece('d', 100, 60)
])
runSortPiecesCase('descending-longest-edge', [
  preparedPiece('small', 50, 50),
  preparedPiece('large', 200, 200),
  preparedPiece('medium', 100, 100)
])
runSortPiecesCase('tie-on-longest-edge-breaks-by-area', [
  preparedPiece('tall-thin', 100, 10), // longestEdge 100, area 1000
  preparedPiece('square', 100, 100), // longestEdge 100, area 10000
  preparedPiece('wide-thin', 10, 100) // longestEdge 100, area 1000 -- ties with tall-thin
])
runSortPiecesCase('tie-on-edge-and-area-breaks-by-imbalance', [
  preparedPiece('rect-a', 100, 90), // area 9000, imbalance 10
  preparedPiece('rect-b', 100, 90) // same dims -- exact duplicate, tests stability
])
{
  // Deliberately interleaved ranks across 12 pieces, several exact 3-way
  // ties on `longestEdge` alone, forcing area/imbalance tie-breaks.
  const pieces: PreparedPiece[] = []
  const dims: ReadonlyArray<[string, number, number]> = [
    ['r1', 80, 20],
    ['r2', 80, 40],
    ['r3', 80, 80],
    ['r4', 150, 10],
    ['r5', 150, 150],
    ['r6', 30, 30],
    ['r7', 200, 5],
    ['r8', 200, 200],
    ['r9', 1, 1],
    ['r10', 80, 20], // exact duplicate of r1
    ['r11', 150, 150], // exact duplicate of r5
    ['r12', 80, 20] // second exact duplicate of r1/r10
  ]
  for (const [id, w, h] of dims) pieces.push(preparedPiece(id, w, h))
  runSortPiecesCase('twelve-piece-mixed-ties', pieces)
}
{
  // Real production data: the full 61-piece fixture, `realBounds` used
  // directly as both bounds fields (padding=0) -- the highest-value single
  // case in this section, using genuine geometry-derived sort keys rather
  // than synthetic dimensions.
  const pieces: PreparedPiece[] = []
  for (let index = 0; index < 61; index += 1) {
    const bounds = fixturePiece(index).realBounds
    pieces.push(preparedPiece(`fixture-${index}`, bounds.width, bounds.height))
  }
  runSortPiecesCase('mixed61-fixture-real-bounds', pieces)
}
{
  // Reversed-input variant of the same 61-piece set: proves the sort is a
  // genuine total order driven by the three keys, not accidentally stable
  // on the *original* TS source array identity/order alone (a differently
  // *ordered* input with the same multiset of pieces must still produce the
  // TS-defined order, which is order-of-appearance-within-ties, not
  // id-alphabetical).
  const pieces: PreparedPiece[] = []
  for (let index = 60; index >= 0; index -= 1) {
    const bounds = fixturePiece(index).realBounds
    pieces.push(preparedPiece(`fixture-${index}`, bounds.width, bounds.height))
  }
  runSortPiecesCase('mixed61-fixture-real-bounds-reversed-input', pieces)
}

// ---------------------------------------------------------------------------
// Assemble + write output.
// ---------------------------------------------------------------------------
const totalCaseCount =
  scoreGridCases.length +
  placementScorerCases.length +
  placementComparatorCases.length +
  layoutScorerCases.length +
  layoutComparatorCases.length +
  sortPiecesCases.length

if (totalCaseCount < 400) {
  throw new Error(`Expected at least 400 total scorer vectors, generated only ${totalCaseCount}.`)
}

mkdirSync(VECTORS_DIR, { recursive: true })

const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-scorers.ts',
  generatingCommit: commit,
  sourceModules: [
    'src/workers/algorithm/irregular/irregularScoreGrid.ts',
    'src/workers/algorithm/irregular/irregularPlacementScorer.ts',
    'src/workers/algorithm/irregular/irregularLayoutScorer.ts',
    'src/workers/algorithm/irregular/irregularBeamState.ts',
    'src/workers/algorithm/sortPiecesForNesting.ts'
  ],
  description:
    'canonicalizeIrregularScoreMillimeters/MillimeterUnits/Scalar over an adversarial numeric matrix; ' +
    'the real IrregularPlacementScorer.Layer.scoreCandidate over a candidate matrix (real mixed61 ' +
    'fixture-piece rings, every IrregularPlacementPolicyId, varied sheets and 0-2 placed neighbors) ' +
    'plus explicit error-path cases and its .compare adjacent-pair outcomes per policy; the real ' +
    'IrregularLayoutScorer.Live.scoreState over real IrregularBeamState incremental chains (exercising ' +
    'the free-material cache parent-fallback path) and fresh flat reconstructions, plus its .compare ' +
    'adjacent-pair outcomes at both the strict and scale-aware term orders; and the real ' +
    'sortPiecesForNesting full output order over tie-heavy synthetic sets and the real 61-piece fixture ' +
    '(forward and reversed input order). Every case records both the raw input (f64 fields as ' +
    'big-endian IEEE-754 bit-pattern hex strings) and the resulting output/error, so the Rust test ' +
    'replays the identical input through its own port rather than a pre-rendered value.',
  totalCaseCount,
  scoreGrid: { caseCount: scoreGridCases.length, cases: scoreGridCases },
  placementScorer: { caseCount: placementScorerCases.length, cases: placementScorerCases },
  placementComparator: { caseCount: placementComparatorCases.length, cases: placementComparatorCases },
  layoutScorer: { caseCount: layoutScorerCases.length, cases: layoutScorerCases },
  layoutComparator: { caseCount: layoutComparatorCases.length, cases: layoutComparatorCases },
  sortPieces: { caseCount: sortPiecesCases.length, cases: sortPiecesCases }
}

writeFileSync(join(VECTORS_DIR, 'scorers.json'), JSON.stringify(output, null, 2) + '\n')

console.log(
  `Wrote ${totalCaseCount} scorer vectors ` +
    `(scoreGrid=${scoreGridCases.length}, placementScorer=${placementScorerCases.length}, ` +
    `placementComparator=${placementComparatorCases.length}, layoutScorer=${layoutScorerCases.length}, ` +
    `layoutComparator=${layoutComparatorCases.length}, sortPieces=${sortPiecesCases.length}; ` +
    `commit ${commit}) to ${VECTORS_DIR}`
)
