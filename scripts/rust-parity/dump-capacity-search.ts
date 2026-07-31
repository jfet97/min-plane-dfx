/**
 * Differential-vector generator for
 * `crates/irregular-nesting-native/src/capacity/search.rs`.
 *
 * Imports the REAL production TS entry point --
 *   `runIntrinsicCapacityColdSearch` (`src/workers/algorithm/irregular/intrinsicCapacitySearch.ts`)
 * -- and evaluates it through the REAL Effect service layer stack
 * (`GeometryKernel.Live`, `GeometrySettings.Live`, `NfpIfpServiceLive` -- the
 * same layers `nesting.worker.ts`/`tests/unit/intrinsicCapacityMode.test.ts`
 * wire into production), driven with `Effect.runSyncExit` (the same
 * synchronous-safe pattern `dump-strict-decoder.ts` already established for
 * this exact layer stack).
 *
 * Determinism: every call in this script supplies its own freshly
 * constructed `timingNow` seam (the R13-sanctioned additive clock seam added
 * to `intrinsicCapacitySearch.ts` itself for this task) -- a simple
 * incrementing counter starting at `1000`, advancing by `1` per call. The
 * checkpoint itself carries no timing field (checkpoint-encoding.md §10.2),
 * so this seam only matters for the diagnostic-only `phaseTimings` this
 * script does not record; it is threaded regardless for full byte-level
 * reproducibility of any future extension.
 *
 * Fixtures: small axis-aligned-rectangle prepared pieces (2-4 pieces per
 * case, capacity-gate-like tight sheets, per this task's brief) plus a
 * smaller battery of real mixed61 convex-hull pieces (via `computeConvexHull`
 * over `tests/fixtures/irregularSheetInvariance/mixed61-request.json`
 * segment endpoints, the same technique `dump-nfp-ifp.ts`/`dump-strict-decoder.ts`
 * use). Every piece carries two transform candidates (0deg, 90deg,
 * `reason: 'configured'`) so `transformCandidateOrder`'s stable sort and the
 * rigid q0/q90 endpoint-orientation selection are both genuinely exercised.
 *
 * Two case shapes populate `>= 400` total vectors:
 *   - `fullRunCases`: an unbounded (`maximumDepthBoundaries` omitted) search
 *     over one piece set / sheet / retention mode, recording every endpoint
 *     (canonical hash, selected rotation, placed/unplaced partitions, full
 *     metrics) and the full trace/counters. A subset additionally supplies
 *     an `incumbent` (materialized from a smaller sub-combo's own best
 *     endpoint) to exercise the strict attainable-count/attainable-material
 *     pruning branches.
 *   - `checkpointCases`: the identical input bounded to
 *     `maximumDepthBoundaries = 1` at every valid depth boundary of the same
 *     piece set, recording the paused checkpoint's own hash-bearing scalar
 *     fields (`requestFingerprint`, `integrityHash`, `producerRole`,
 *     `archiveCohort`, `nextDepth`) for the Rust port's own,
 *     independently-constructed checkpoint to match byte-exactly (a SHA-256
 *     match is only reachable if the Rust preimage bytes are themselves
 *     byte-identical, since SHA-256 is collision-resistant -- the practical,
 *     verifiable form of "integrity-hash preimage byte-exact" given the
 *     preimage-building function is itself TS-module-private), plus the
 *     paired unbounded run's final endpoints/trace as the ground truth the
 *     Rust port's own bounded-then-resumed replay must reach
 *     (`resumed == uninterrupted`).
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-capacity-search.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/capacity-search.json
 */
import { Effect } from 'effect'
import { createHash } from 'node:crypto'
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
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransformCandidate
} from '../../src/shared/irregular/domain.js'
import { computeConvexHull } from '../../src/workers/irregular/core/convexHullCore.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { intrinsicCapacityMaterialAreas } from '../../src/workers/algorithm/irregular/intrinsicCapacityMaterial.js'
import {
  runIntrinsicCapacityColdSearch,
  type IntrinsicAnytimeCheckpoint,
  type IntrinsicCapacityRetentionMode,
  type IntrinsicCapacitySearchResult
} from '../../src/workers/algorithm/irregular/intrinsicCapacitySearch.js'
import type {
  IntrinsicCapacityCavityCache,
  IntrinsicCapacityEndpoint as _IntrinsicCapacityEndpointType
} from '../../src/workers/algorithm/irregular/intrinsicCapacityEndpoint.js'

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
// f64 -> exact big-endian IEEE-754 bit-pattern hex string (matches every
// other dump script's own `f64Bits` convention exactly).
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

// ---------------------------------------------------------------------------
// Domain-object construction helpers (mirror `dump-strict-decoder.ts`'s own
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

function transformCandidate(index: number, rotationDeg: number): IrregularTransformCandidate {
  return new IrregularTransformCandidate({ index, rotationDeg, mirrored: false, reason: 'configured' })
}

function preparedPiece(id: string, points: ReadonlyArray<IrregularPoint>): IrregularPreparedPiece {
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
    transforms: [transformCandidate(0, 0), transformCandidate(1, 90)]
  })
}

function rectanglePoints(width: number, height: number): IrregularPoint[] {
  return [point(0, 0), point(width, 0), point(width, height), point(0, height)]
}

function sheetSpec(width: number, height: number): SheetSpec {
  return new SheetSpec({ width, height, label: `dump-capacity-search ${width}x${height}` })
}

// ---------------------------------------------------------------------------
// Real mixed61 fixture-piece hull rings (mirrors `dump-strict-decoder.ts`'s
// own `fixtureHullRing`).
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
// Rectangle piece bank and combos.
// ---------------------------------------------------------------------------
const RECTANGLES: ReadonlyArray<{ readonly key: string; readonly width: number; readonly height: number }> = [
  { key: 'r1', width: 40, height: 30 },
  { key: 'r2', width: 35, height: 25 },
  { key: 'r3', width: 50, height: 20 },
  { key: 'r4', width: 30, height: 30 },
  { key: 'r5', width: 45, height: 15 }
]

const RECT_COMBOS: ReadonlyArray<ReadonlyArray<string>> = [
  ['r1', 'r2'],
  ['r1', 'r3'],
  ['r2', 'r4'],
  ['r3', 'r5'],
  ['r4', 'r5'],
  ['r1', 'r2', 'r3'],
  ['r1', 'r4', 'r5'],
  ['r2', 'r3', 'r4'],
  ['r1', 'r2', 'r4'],
  ['r3', 'r4', 'r5'],
  ['r1', 'r2', 'r3', 'r4'],
  ['r1', 'r2', 'r3', 'r5'],
  ['r1', 'r2', 'r4', 'r5'],
  ['r1', 'r3', 'r4', 'r5'],
  ['r2', 'r3', 'r4', 'r5']
]

function rectComboPieces(comboIndex: number, combo: ReadonlyArray<string>): IrregularPreparedPiece[] {
  return combo.map((key, index) => {
    const spec = RECTANGLES.find((r) => r.key === key)
    if (spec === undefined) throw new Error(`unknown rectangle key ${key}`)
    return preparedPiece(`combo${comboIndex}-${key}-${index}`, rectanglePoints(spec.width, spec.height))
  })
}

const MIXED61_COMBOS: ReadonlyArray<ReadonlyArray<number>> = [
  [3, 11, 22],
  [5, 17, 29],
  [7, 19, 31],
  [3, 11, 22, 40],
  [5, 17, 29, 44],
  [7, 19, 31, 48],
  [9, 21],
  [13, 27],
  [15, 33]
]

function mixed61ComboPieces(comboIndex: number, combo: ReadonlyArray<number>): IrregularPreparedPiece[] {
  return combo.map((slot, index) =>
    preparedPiece(`m61combo${comboIndex}-${slot}-${index}`, fixtureHullRing(slot))
  )
}

const SHEETS: ReadonlyArray<{ readonly key: string; readonly width: number; readonly height: number }> = [
  { key: 'sheetA', width: 70, height: 50 },
  { key: 'sheetB', width: 60, height: 45 },
  { key: 'sheetC', width: 55, height: 40 }
]

const RETENTION_MODES: ReadonlyArray<IntrinsicCapacityRetentionMode> = ['objective', 'cohesion-frontier']

// ---------------------------------------------------------------------------
// Effect layer runner.
// ---------------------------------------------------------------------------
function runSearch(
  input: Parameters<typeof runIntrinsicCapacityColdSearch>[0]
): ReturnType<typeof Effect.runSyncExit<IntrinsicCapacitySearchResult, unknown>> {
  return Effect.runSyncExit(
    runIntrinsicCapacityColdSearch(input).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  ) as ReturnType<typeof Effect.runSyncExit<IntrinsicCapacitySearchResult, unknown>>
}

function materialAreasFor(pieces: ReadonlyArray<IrregularPreparedPiece>): ReadonlyMap<PieceId, bigint> {
  const areas = intrinsicCapacityMaterialAreas(pieces)
  if (areas.kind !== 'complete') {
    throw new Error(`material accounting failed for piece ${areas.pieceId}`)
  }
  return areas.areasByPieceId
}

// ---------------------------------------------------------------------------
// Encoding helpers.
// ---------------------------------------------------------------------------
function encodePoint(p: { readonly x: number; readonly y: number }) {
  return { x: f64Bits(p.x), y: f64Bits(p.y) }
}
function encodePreparedPiece(piece: IrregularPreparedPiece) {
  return {
    pieceId: piece.pieceId,
    points: piece.collisionGeometry.collisionPolygon.points.map(encodePoint),
    transforms: piece.transforms.map((t) => ({
      index: f64Bits(t.index),
      rotationDeg: f64Bits(t.rotationDeg),
      mirrored: t.mirrored,
      reason: t.reason
    }))
  }
}
function encodeSheet(sheet: SheetSpec) {
  // `label` is recorded verbatim (not bit-pattern-encoded, it is a plain
  // string): the request fingerprint hashes the *whole* `SheetSpec`
  // (`intrinsicCapacityRequestFingerprint`), so the Rust replay must
  // reconstruct byte-identical label text, not merely identical dimensions.
  return { width: f64Bits(sheet.width), height: f64Bits(sheet.height), label: sheet.label }
}
function encodeEndpoint(endpoint: {
  readonly origin: string
  readonly sourceRole: string | undefined
  readonly prefixDepth: number | undefined
  readonly placedPreparedIds: ReadonlyArray<PieceId>
  readonly unplacedPreparedIds: ReadonlyArray<PieceId>
  readonly selectedRotationDeg: number
  readonly canonicalGeometryHash: string
  readonly metrics: {
    readonly placedCount: number
    readonly placedDoubledMaterialAreaGrid2: bigint
    readonly placedMaterialAreaMm2: number
    readonly enclosedCavityCount: number
    readonly totalEnclosedCavityAreaMm2: number
    readonly totalEnclosedCavityDoubledAreaGrid2: string
    readonly envelopeMaximumSideMm: number
    readonly envelopeAreaMm2: number
    readonly envelopeSpanMm: number
    readonly envelopeMaximumSideGrid: number
    readonly envelopeAreaGrid2: string
    readonly envelopeSpanGrid: number
  }
}) {
  return {
    origin: endpoint.origin,
    sourceRole: endpoint.sourceRole ?? null,
    prefixDepth: endpoint.prefixDepth === undefined ? null : f64Bits(endpoint.prefixDepth),
    placedPreparedIds: endpoint.placedPreparedIds,
    unplacedPreparedIds: endpoint.unplacedPreparedIds,
    selectedRotationDeg: f64Bits(endpoint.selectedRotationDeg),
    canonicalGeometryHash: endpoint.canonicalGeometryHash,
    metrics: {
      placedCount: f64Bits(endpoint.metrics.placedCount),
      placedDoubledMaterialAreaGrid2: endpoint.metrics.placedDoubledMaterialAreaGrid2.toString(),
      enclosedCavityCount: f64Bits(endpoint.metrics.enclosedCavityCount),
      totalEnclosedCavityDoubledAreaGrid2: endpoint.metrics.totalEnclosedCavityDoubledAreaGrid2,
      envelopeMaximumSideGrid: f64Bits(endpoint.metrics.envelopeMaximumSideGrid),
      envelopeAreaGrid2: endpoint.metrics.envelopeAreaGrid2,
      envelopeSpanGrid: f64Bits(endpoint.metrics.envelopeSpanGrid)
    }
  }
}
function encodeTrace(trace: IntrinsicCapacitySearchResult['trace']) {
  return {
    beamWidth: f64Bits(trace.beamWidth),
    localLegalPlacementFanout: f64Bits(trace.localLegalPlacementFanout),
    placementEvaluationCap: f64Bits(trace.placementEvaluationCap),
    placementEvaluationQuotaPerDepth: f64Bits(trace.placementEvaluationQuotaPerDepth),
    consumedPlacementEvaluations: f64Bits(trace.consumedPlacementEvaluations),
    prunedByAttainableCount: f64Bits(trace.prunedByAttainableCount),
    prunedByAttainableMaterial: f64Bits(trace.prunedByAttainableMaterial),
    deduplicatedSuccessors: f64Bits(trace.deduplicatedSuccessors),
    fitRejectedCandidates: f64Bits(trace.fitRejectedCandidates),
    invalidCandidates: f64Bits(trace.invalidCandidates),
    endpointFitRejections: f64Bits(trace.endpointFitRejections),
    completedDepths: f64Bits(trace.completedDepths),
    depthQuotaExhaustions: f64Bits(trace.depthQuotaExhaustions),
    pieceCount: f64Bits(trace.pieceCount),
    settlement: trace.settlement
  }
}

// ---------------------------------------------------------------------------
// Case generation.
// ---------------------------------------------------------------------------
interface FullRunCase {
  readonly caseId: string
  readonly pieces: ReturnType<typeof encodePreparedPiece>[]
  readonly sheet: ReturnType<typeof encodeSheet>
  readonly retentionMode: IntrinsicCapacityRetentionMode
  readonly hasIncumbent: boolean
  readonly incumbentSourcePieceCount: number | null
  /** Full `encodeEndpoint` projection of the real incumbent object passed
   *  into `runSearch`, so the Rust replay can reconstruct an equivalent
   *  `IntrinsicCapacityEndpoint` (only `metrics.placedCount`/
   *  `metrics.placedDoubledMaterialAreaGrid2` participate in pruning
   *  decisions, but every field is recorded for full fidelity). `null` when
   *  `hasIncumbent` is `false`. */
  readonly incumbent: ReturnType<typeof encodeEndpoint> | null
  readonly status: string
  readonly endpoints: ReturnType<typeof encodeEndpoint>[]
  readonly trace: ReturnType<typeof encodeTrace>
}

interface CheckpointCase {
  readonly caseId: string
  readonly pieces: ReturnType<typeof encodePreparedPiece>[]
  readonly sheet: ReturnType<typeof encodeSheet>
  readonly retentionMode: IntrinsicCapacityRetentionMode
  readonly maximumDepthBoundaries: string
  readonly status: string
  readonly requestFingerprint: string
  readonly integrityHash: string
  readonly nextDepth: string
  readonly producerRole: string
  readonly archiveCohort: string
  readonly expectedFinalStatus: string
  readonly expectedFinalEndpoints: ReturnType<typeof encodeEndpoint>[]
  readonly expectedFinalTrace: ReturnType<typeof encodeTrace>
}

const fullRunCases: FullRunCase[] = []
const checkpointCases: CheckpointCase[] = []

function unwrapExit(exit: ReturnType<typeof runSearch>, caseId: string): IntrinsicCapacitySearchResult {
  if (exit._tag !== 'Success') {
    throw new Error(`case ${caseId} failed: ${JSON.stringify(exit)}`)
  }
  return exit.value
}

function runFullAndBoundaries(
  caseIdPrefix: string,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  sheet: SheetSpec,
  retentionMode: IntrinsicCapacityRetentionMode,
  incumbent: _IntrinsicCapacityEndpointType | undefined,
  incumbentSourcePieceCount: number | null
): void {
  const materialAreas = materialAreasFor(pieces)
  const encodedPieces = pieces.map(encodePreparedPiece)
  const encodedSheet = encodeSheet(sheet)

  const fullCache: IntrinsicCapacityCavityCache = new Map()
  const fullExit = runSearch({
    sheet,
    preparedPieces: pieces,
    materialAreasByPieceId: materialAreas,
    cavityCache: fullCache,
    ...(incumbent === undefined ? {} : { incumbent }),
    retentionMode,
    timingNow: makeClock()
  })
  const fullResult = unwrapExit(fullExit, caseIdPrefix)
  fullRunCases.push({
    caseId: caseIdPrefix,
    pieces: encodedPieces,
    sheet: encodedSheet,
    retentionMode,
    hasIncumbent: incumbent !== undefined,
    incumbentSourcePieceCount,
    incumbent: incumbent === undefined ? null : encodeEndpoint(incumbent),
    status: fullResult.status,
    endpoints: fullResult.endpoints.map(encodeEndpoint),
    trace: encodeTrace(fullResult.trace)
  })

  // Only generate checkpoint cases (and their expected-final ground truth)
  // for the no-incumbent lane -- checkpoint resume is a structural property
  // of the search engine itself, independent of pruning.
  if (incumbent !== undefined) return
  const groundTruthCache: IntrinsicCapacityCavityCache = new Map()
  const groundTruthExit = runSearch({
    sheet,
    preparedPieces: pieces,
    materialAreasByPieceId: materialAreas,
    cavityCache: groundTruthCache,
    retentionMode,
    timingNow: makeClock()
  })
  const groundTruth = unwrapExit(groundTruthExit, `${caseIdPrefix}-ground-truth`)

  for (let boundary = 1; boundary < pieces.length; boundary += 1) {
    const checkpointCache: IntrinsicCapacityCavityCache = new Map()
    const checkpointExit = runSearch({
      sheet,
      preparedPieces: pieces,
      materialAreasByPieceId: materialAreas,
      cavityCache: checkpointCache,
      retentionMode,
      maximumDepthBoundaries: boundary,
      timingNow: makeClock()
    })
    const checkpointResult = unwrapExit(checkpointExit, `${caseIdPrefix}-boundary-${boundary}`)
    if (checkpointResult.status !== 'paused' || checkpointResult.checkpoint === undefined) {
      throw new Error(`expected a paused checkpoint at boundary ${boundary} for ${caseIdPrefix}`)
    }
    const checkpoint: IntrinsicAnytimeCheckpoint = checkpointResult.checkpoint
    checkpointCases.push({
      caseId: `${caseIdPrefix}-boundary-${boundary}`,
      pieces: encodedPieces,
      sheet: encodedSheet,
      retentionMode,
      maximumDepthBoundaries: f64Bits(boundary),
      status: checkpointResult.status,
      requestFingerprint: checkpoint.requestFingerprint,
      integrityHash: checkpoint.integrityHash,
      nextDepth: f64Bits(checkpoint.nextDepth),
      producerRole: checkpoint.producerRole,
      archiveCohort: checkpoint.archiveCohort,
      expectedFinalStatus: groundTruth.status,
      expectedFinalEndpoints: groundTruth.endpoints.map(encodeEndpoint),
      expectedFinalTrace: encodeTrace(groundTruth.trace)
    })
  }
}

// Rectangle combos x sheets x retention modes.
RECT_COMBOS.forEach((combo, comboIndex) => {
  SHEETS.forEach((sheet) => {
    RETENTION_MODES.forEach((mode) => {
      const pieces = rectComboPieces(comboIndex, combo)
      const caseId = `rect-combo${comboIndex}-${sheet.key}-${mode}`
      runFullAndBoundaries(caseId, pieces, sheetSpec(sheet.width, sheet.height), mode, undefined, null)
    })
  })
})

// Additional coverage (additive, appended after the initial battery above):
// `RETENTION_MODES` only exercises `'objective'`/`'cohesion-frontier'`,
// leaving `retainCapacityBeamEntries`'s `'area-first-shadow'`,
// `'axis-buckets-shadow'`, `'cohesion-frontier-shadow'`, and
// `'quality-frontier'` branches -- each a structurally distinct
// comparator/bucket-reservation path in the Rust port's own
// `retain_capacity_beam_entries` -- with zero differential coverage. Exercise
// all four over a modest combo/sheet subset (not the full cross product, to
// keep dump/test runtime bounded) so every `IntrinsicCapacityRetentionMode`
// variant is proven byte-exact against the real TS engine at least once.
const UNDEREXERCISED_RETENTION_MODES: ReadonlyArray<IntrinsicCapacityRetentionMode> = [
  'area-first-shadow',
  'axis-buckets-shadow',
  'cohesion-frontier-shadow',
  'quality-frontier'
]
RECT_COMBOS.slice(0, 6).forEach((combo, comboIndex) => {
  SHEETS.forEach((sheet) => {
    UNDEREXERCISED_RETENTION_MODES.forEach((mode) => {
      const pieces = rectComboPieces(comboIndex, combo)
      const caseId = `rect-combo${comboIndex}-${sheet.key}-${mode}`
      runFullAndBoundaries(caseId, pieces, sheetSpec(sheet.width, sheet.height), mode, undefined, null)
    })
  })
})

// Incumbent-pruning cases: for combos of >= 3 pieces, materialize a smaller
// sub-combo's best endpoint (unbounded, objective mode) as the incumbent for
// the full combo -- exercises the strict attainable-count/attainable-material
// pruning branches.
RECT_COMBOS.forEach((combo, comboIndex) => {
  if (combo.length < 3) return
  SHEETS.forEach((sheet) => {
    const subCombo = combo.slice(0, combo.length - 1)
    const subPieces = rectComboPieces(comboIndex, subCombo)
    const subMaterial = materialAreasFor(subPieces)
    const subCache: IntrinsicCapacityCavityCache = new Map()
    const subExit = runSearch({
      sheet: sheetSpec(sheet.width, sheet.height),
      preparedPieces: subPieces,
      materialAreasByPieceId: subMaterial,
      cavityCache: subCache,
      retentionMode: 'objective',
      timingNow: makeClock()
    })
    const subResult = unwrapExit(subExit, `incumbent-source-combo${comboIndex}-${sheet.key}`)
    const incumbent = subResult.endpoints[0]
    if (incumbent === undefined) return
    const pieces = rectComboPieces(comboIndex, combo)
    const caseId = `rect-combo${comboIndex}-${sheet.key}-objective-incumbent`
    runFullAndBoundaries(
      caseId,
      pieces,
      sheetSpec(sheet.width, sheet.height),
      'objective',
      incumbent,
      subCombo.length
    )
  })
})

// Mixed61 hull combos x a subset of sheets x retention modes.
const MIXED61_SHEETS = SHEETS.slice(0, 2)
MIXED61_COMBOS.forEach((combo, comboIndex) => {
  MIXED61_SHEETS.forEach((sheet) => {
    RETENTION_MODES.forEach((mode) => {
      const pieces = mixed61ComboPieces(comboIndex, combo)
      const caseId = `m61-combo${comboIndex}-${sheet.key}-${mode}`
      runFullAndBoundaries(caseId, pieces, sheetSpec(sheet.width, sheet.height), mode, undefined, null)
    })
  })
})

// ===========================================================================
// Vector-count accounting and write-out.
// ===========================================================================
const totalVectorCount = fullRunCases.length + checkpointCases.length
if (totalVectorCount < 400) {
  throw new Error(`Expected >= 400 capacity-search vectors, got ${totalVectorCount}.`)
}

mkdirSync(VECTORS_DIR, { recursive: true })
const commit = generatingCommit()

const settingsJson = JSON.parse(
  JSON.stringify(DEFAULT_IRREGULAR_NESTING_SETTINGS, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value
  )
) as unknown

const output = {
  generatedByScript: 'scripts/rust-parity/dump-capacity-search.ts',
  generatingCommit: commit,
  description:
    'intrinsicCapacitySearch.ts runIntrinsicCapacityColdSearch full-port coverage: unbounded full-run ' +
    'cases across small axis-aligned-rectangle prepared-piece combinations (2-4 pieces) on ' +
    'capacity-gate-like tight sheets, crossed with objective/cohesion-frontier retention modes (plus a ' +
    'smaller additive battery over the remaining four retention modes -- area-first-shadow/' +
    'axis-buckets-shadow/cohesion-frontier-shadow/quality-frontier -- across a subset of the same combos, ' +
    'so every retainCapacityBeamEntries branch is proven byte-exact at least once), plus a ' +
    'real mixed61-convex-hull battery and a strict attainable-count/attainable-material incumbent-pruning ' +
    'battery; and bounded (maximumDepthBoundaries) checkpoint cases at every valid depth boundary of the ' +
    'same fixtures, recording the paused checkpoint requestFingerprint/integrityHash/producerRole/' +
    'archiveCohort/nextDepth for byte-exact cross-language reproduction plus the uninterrupted-run ground ' +
    'truth (status/endpoints/trace) the Rust port\'s own bounded-then-resumed replay must reach exactly. ' +
    'f64 values are recorded as big-endian IEEE-754 bit-pattern hex strings for bit-exact comparison; ' +
    'BigInt/doubled-area-grid2 fields are recorded verbatim as decimal strings. The timingNow seam is a ' +
    'fresh incrementing counter starting at 1000 (+1 per call) constructed once per search invocation ' +
    '(per the R13-sanctioned additive clock seam); the checkpoint itself carries no timing field, so this ' +
    'seam only affects the (unrecorded) diagnostic phaseTimings output. `settings` is the byte-exact JSON ' +
    'projection of the real production DEFAULT_IRREGULAR_NESTING_SETTINGS (GeometrySettings.Live).',
  clockStartValue: f64Bits(1000),
  clockIncrement: f64Bits(1),
  settings: settingsJson,
  fullRunCaseCount: fullRunCases.length,
  fullRunCases,
  checkpointCaseCount: checkpointCases.length,
  checkpointCases,
  totalVectorCount
}

writeFileSync(join(VECTORS_DIR, 'capacity-search.json'), JSON.stringify(output, null, 2) + '\n')

// Self-check: SHA-256 of the written file's own bytes is stable across
// re-runs on an unchanged commit (a cheap sanity signal, not itself part of
// the differential contract).
const fileBytes = readFileSync(join(VECTORS_DIR, 'capacity-search.json'))
const fileHash = createHash('sha256').update(fileBytes).digest('hex')

console.log(
  `Wrote ${fullRunCases.length} full-run and ${checkpointCases.length} checkpoint cases ` +
    `(${totalVectorCount} total vectors, commit ${commit}, file sha256 ${fileHash}) to ${VECTORS_DIR}`
)
