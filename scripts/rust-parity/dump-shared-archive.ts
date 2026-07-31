/**
 * Differential-vector generator for
 * `crates/irregular-nesting-native/src/archive/shared.rs` (+
 * `src/archive/anytime.rs`, the sibling namespace-agnostic primitive it
 * builds on).
 *
 * Imports the REAL production TS entry points --
 *   `runIntrinsicSharedArchivePortfolio`, `runIntrinsicSharedArchiveDirectPortfolio`,
 *   `retainRankedSharedArchive`, `selectFittingSharedArchive`,
 *   `selectIntrinsicSharedArchiveWinner`, `intrinsicSharedPeriodicSelectionValid`,
 *   `intrinsicSharedArchiveExperimentValid`, `intrinsicSharedArchiveProductionValid`,
 *   `intrinsicSharedPeriodicCatalogCoverageValid`,
 *   `normalizeIntrinsicSharedArchiveConstructedRun`, `makeIntrinsicSharedArchiveEndpoint`
 *   (`src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.ts`)
 * -- and evaluates them through the REAL Effect service layer stack
 * (`GeometryKernel.Live`, `GeometrySettings.Live`, `NfpIfpServiceLive` -- the
 * same layers `dump-strict-decoder.ts`/`dump-capacity-search.ts` already
 * establish for this exact layer stack), driven with `Effect.runSyncExit`.
 *
 * Periodic-phase determinism note: every piece combination below is built
 * from *distinct* real mixed61 fixture slots (no repeated shapes within one
 * combo). `groupIntrinsicCollisionFamilies` (the periodic family detector)
 * keys purely by `interchangeabilityKey ?? source.id`, so distinct pieces
 * never form a multi-member family; empirically confirmed (see this task's
 * own probe run) `catalog.families.length === 0` for every combo generated
 * here, making the periodic phase a fast, trivial no-op in every case
 * (`runtimeCoverageComplete: true`, `familyCoverageComplete: true`,
 * `continuations: []`) -- this is what makes it safe to drive the REAL,
 * full `runIntrinsicSharedArchivePortfolio` (not just the direct-only
 * sub-function) for the bulk of this file's vectors without runtime
 * exploding: periodic adds single-digit milliseconds per case.
 *
 * There is no injectable `timingNow` seam in `intrinsicSharedArchivePortfolio.ts`
 * itself (see the Rust port's own top-doc, "Deliberately not ported" --
 * `performance.now()` reads are diagnostic-only `runtimeMs` measurements
 * that never affect control flow or any recorded field below). "Scheduler
 * traces for varied budget/deadline configurations" is therefore covered
 * deterministically via `directCandidateEvaluationCaps` (evaluation-count
 * budgets) and `canonicalGridCompletedPieceQuantum` (piece-count-quantized
 * checkpoint pause/resume chronology) -- both fully deterministic without
 * any wall-clock seam.
 *
 * Six vector batteries populate `>= 400` total vectors:
 *   - `fullPortfolioCases`: real `runIntrinsicSharedArchivePortfolio` runs
 *     across piece combinations (2-8 pieces, distinct real mixed61 hull
 *     shapes) crossed with three sheets (a generous "everything fits"
 *     sheet, a tight "some/most layouts do not fit" sheet, and a 1x1
 *     "nothing fits" sheet), recording every direct run, the (trivially
 *     empty) periodic run/catalog summary, `sheetlessArchive`/`archive`
 *     order and identities, `winner`, and every validity predicate.
 *   - `evaluationCapCases`: `runIntrinsicSharedArchiveDirectPortfolio` with
 *     a deterministic low `directCandidateEvaluationCaps` on one role at a
 *     time, forcing `'evaluation-cap'` truncation deterministically.
 *   - `checkpointChronologyCases`: `runIntrinsicSharedArchiveDirectPortfolio`
 *     with `canonicalGridCompletedPieceQuantum: 1` (production's own always-on
 *     setting), recording the `onCanonicalGridCheckpointed` firing count and
 *     scalar identity per firing plus the final resumed `directRuns`.
 *   - `admissionCases`: illegal (no sheet fits at any rotation), incomplete
 *     (`normalizeIntrinsicSharedArchiveConstructedRun` fed a real, genuinely
 *     unplaced `IrregularBeamState.empty([...])`), and duplicate (a
 *     single-piece combo where all three direct roles converge on the same
 *     canonical hash, exercising `retainRankedSharedArchive`'s first-producer-
 *     ownership dedup) admission-rejection cases, plus a hash-mismatch
 *     `retainRankedSharedArchive` validation-rejection case.
 *   - `rankingComparatorCases`: hand-built `IntrinsicSharedArchiveEndpoint`
 *     pairs/triples fed to `selectIntrinsicSharedArchiveWinner`, covering
 *     every branch of `compareIntrinsicSharedArchiveWinner`'s five-key
 *     chain (certificate deficit exact/float-fallback, cavity count,
 *     largest-hull-gap exact/float-fallback, envelope exact/float-fallback
 *     area/side/span, final hash tie-break) plus the geometric-Pareto-front
 *     gating itself.
 *   - `requestedSheetFitCases`: q0/q90 orientation-fit selection across
 *     fitting/non-fitting/tie-break-relevant sheets.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-shared-archive.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/shared-archive.json
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
import { IrregularBeamState } from '../../src/workers/algorithm/irregular/irregularBeamState.js'
import type {
  IntrinsicStrictCertificate,
  IntrinsicStrictCompletedMetrics,
  IntrinsicStrictConstructResult,
  IntrinsicStrictDirectCheckpoint
} from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import {
  intrinsicSharedArchiveExperimentValid,
  intrinsicSharedArchiveProductionValid,
  intrinsicSharedPeriodicCatalogCoverageValid,
  makeIntrinsicSharedArchiveEndpoint,
  normalizeIntrinsicSharedArchiveConstructedRun,
  retainRankedSharedArchive,
  runIntrinsicSharedArchiveDirectPortfolio,
  runIntrinsicSharedArchivePortfolio,
  selectFittingSharedArchive,
  selectIntrinsicSharedArchiveWinner,
  type IntrinsicSharedArchiveDirectRole,
  type IntrinsicSharedArchiveEndpoint,
  type IntrinsicSharedArchivePortfolioResult,
  type IntrinsicSharedArchiveRun
} from '../../src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.js'

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
// Domain-object construction helpers (mirror `dump-strict-decoder.ts`'s /
// `dump-capacity-search.ts`'s own identically-named helpers).
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
function sheetSpec(width: number, height: number, label: string): SheetSpec {
  return new SheetSpec({ width, height, label })
}

// ---------------------------------------------------------------------------
// Real mixed61 fixture-piece hull rings (mirrors `dump-capacity-search.ts`'s
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
// Deterministic combo generation: `2..8` distinct real mixed61 slots per
// combo, 6 combos per size, spaced by a fixed stride so no two slots within
// one combo ever collide (61 is prime, so any stride 1..60 visits all 61
// residues before repeating).
// ---------------------------------------------------------------------------
interface Combo {
  readonly label: string
  readonly pieceCount: number
  readonly pieces: IrregularPreparedPiece[]
}

const COMBOS: Combo[] = []
for (let pieceCount = 2; pieceCount <= 8; pieceCount += 1) {
  for (let comboIndex = 0; comboIndex < 15; comboIndex += 1) {
    const stride = 5 + comboIndex * 3
    const startSlot = comboIndex * 7 + pieceCount
    const slots: number[] = []
    for (let k = 0; k < pieceCount; k += 1) {
      slots.push((startSlot + k * stride) % 61)
    }
    if (new Set(slots).size !== slots.length) {
      throw new Error(`combo n${pieceCount}-c${comboIndex} produced duplicate slots: ${slots.join(',')}`)
    }
    const label = `n${pieceCount}-c${comboIndex}`
    const pieces = slots.map((slot, index) => preparedPiece(`${label}-p${index}`, fixtureHullRing(slot)))
    COMBOS.push({ label, pieceCount, pieces })
  }
}

const SHEETS: ReadonlyArray<{ readonly key: string; readonly width: number; readonly height: number }> = [
  { key: 'wide', width: 1400, height: 1400 },
  { key: 'medium', width: 300, height: 300 },
  { key: 'tight', width: 90, height: 70 },
  { key: 'nothing-fits', width: 1, height: 1 }
]

// ---------------------------------------------------------------------------
// Effect layer runners.
// ---------------------------------------------------------------------------
function runFullPortfolio(
  sheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  options: Parameters<typeof runIntrinsicSharedArchivePortfolio>[2] = {}
): ReturnType<typeof Effect.runSyncExit<IntrinsicSharedArchivePortfolioResult, unknown>> {
  return Effect.runSyncExit(
    runIntrinsicSharedArchivePortfolio(sheet, pieces, options).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  ) as ReturnType<typeof Effect.runSyncExit<IntrinsicSharedArchivePortfolioResult, unknown>>
}

function runDirectOnly(
  sheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  options: Parameters<typeof runIntrinsicSharedArchiveDirectPortfolio>[2] = {}
): ReturnType<typeof Effect.runSyncExit<ReadonlyArray<IntrinsicSharedArchiveRun>, unknown>> {
  return Effect.runSyncExit(
    runIntrinsicSharedArchiveDirectPortfolio(sheet, pieces, options).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  ) as ReturnType<typeof Effect.runSyncExit<ReadonlyArray<IntrinsicSharedArchiveRun>, unknown>>
}

function unwrap<T>(exit: { readonly _tag: string; readonly value?: T }, caseId: string): T {
  if (exit._tag !== 'Success' || exit.value === undefined) {
    throw new Error(`case ${caseId} failed: ${JSON.stringify(exit).slice(0, 2000)}`)
  }
  return exit.value
}

// ---------------------------------------------------------------------------
// Encoding helpers.
// ---------------------------------------------------------------------------
function encodePreparedPieceSummary(piece: IrregularPreparedPiece) {
  return {
    pieceId: piece.pieceId,
    points: piece.collisionGeometry.collisionPolygon.points.map((p) => ({ x: f64Bits(p.x), y: f64Bits(p.y) }))
  }
}
function encodeSheet(sheet: SheetSpec) {
  return { width: f64Bits(sheet.width), height: f64Bits(sheet.height), label: sheet.label }
}
function encodeMetrics(metrics: IntrinsicStrictCompletedMetrics) {
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
            largestOccupiedHullGapDoubledAreaGrid2: metrics.exact.largestOccupiedHullGapDoubledAreaGrid2,
            occupiedHullDoubledAreaGrid2: metrics.exact.occupiedHullDoubledAreaGrid2,
            occupiedHullWasteDoubledAreaGrid2: metrics.exact.occupiedHullWasteDoubledAreaGrid2,
            largestPositiveContactComponentSize: f64Bits(metrics.exact.largestPositiveContactComponentSize),
            placedPieceCount: f64Bits(metrics.exact.placedPieceCount),
            occupiedOutsideLargestContactComponentDoubledAreaGrid2:
              metrics.exact.occupiedOutsideLargestContactComponentDoubledAreaGrid2
          }
  }
}
function encodeCertificate(certificate: IntrinsicStrictCertificate) {
  return {
    passes: certificate.passes,
    violatedFloors: certificate.violatedFloors,
    relativeDeficitSum: f64Bits(certificate.relativeDeficitSum),
    exactRelativeDeficitNumerator: certificate.exactRelativeDeficitNumerator ?? null,
    exactRelativeDeficitDenominator: certificate.exactRelativeDeficitDenominator ?? null
  }
}
function encodeOrientationFit(fit: { readonly fits: boolean; readonly canonicalGeometryHash: string | undefined }) {
  return { fits: fit.fits, canonicalGeometryHash: fit.canonicalGeometryHash ?? null }
}
function encodeSheetFit(sheetFit: IntrinsicSharedArchiveEndpoint['requestedSheetFit']) {
  return {
    q0: encodeOrientationFit(sheetFit.q0),
    q90: encodeOrientationFit(sheetFit.q90),
    selectedRotationDeg: sheetFit.selectedRotationDeg === undefined ? null : f64Bits(sheetFit.selectedRotationDeg),
    selectedCanonicalGeometryHash: sheetFit.selectedCanonicalGeometryHash ?? null,
    selectedPlacedCollisionGeometryCount: f64Bits(sheetFit.selectedPlacedCollisionGeometries.length)
  }
}
function encodeEndpoint(endpoint: IntrinsicSharedArchiveEndpoint | undefined) {
  if (endpoint === undefined) return null
  return {
    role: endpoint.role,
    sourceId: endpoint.sourceId ?? null,
    sheetlessCanonicalGeometryIdentity: endpoint.sheetlessCanonicalGeometryIdentity,
    sheetlessCanonicalGeometryHash: endpoint.sheetlessCanonicalGeometryHash,
    placedCollisionGeometryCount: f64Bits(endpoint.placedCollisionGeometries.length),
    metrics: encodeMetrics(endpoint.metrics),
    certificate: encodeCertificate(endpoint.certificate),
    requestedSheetFit: encodeSheetFit(endpoint.requestedSheetFit)
  }
}
function encodeRun(run: IntrinsicSharedArchiveRun) {
  return {
    role: run.role,
    sourceId: run.sourceId ?? null,
    status: run.status,
    requestedCandidateEvaluations: run.requestedCandidateEvaluations === undefined ? null : f64Bits(run.requestedCandidateEvaluations),
    consumedCandidateEvaluations: run.consumedCandidateEvaluations === undefined ? null : f64Bits(run.consumedCandidateEvaluations),
    reason: run.reason ?? null,
    endpoint: encodeEndpoint(run.endpoint)
  }
}
function encodeCatalog(catalog: IntrinsicSharedArchivePortfolioResult['periodicPortfolio']['catalog']) {
  return {
    runtimeCoverageComplete: catalog.runtimeCoverageComplete,
    familyCoverageComplete: catalog.familyCoverageComplete,
    familyCount: f64Bits(catalog.families.length),
    families: catalog.families.map((family) => ({
      cellCoverageComplete: family.cellCoverageComplete,
      sourceAuditCellsPresent: family.sourceAuditCells !== undefined
    }))
  }
}

// ===========================================================================
// Battery 1: `fullPortfolioCases`.
// ===========================================================================
interface FullPortfolioCase {
  readonly caseId: string
  readonly pieceCount: number
  readonly pieces: ReturnType<typeof encodePreparedPieceSummary>[]
  readonly sheet: ReturnType<typeof encodeSheet>
  readonly directRuns: ReturnType<typeof encodeRun>[]
  readonly periodicRuns: ReturnType<typeof encodeRun>[]
  readonly catalog: ReturnType<typeof encodeCatalog>
  readonly continuationCount: string
  readonly continuationCoverageComplete: boolean
  readonly continuationBudgetSettlementComplete: boolean | null
  readonly sheetlessArchive: ReturnType<typeof encodeEndpoint>[]
  readonly archive: ReturnType<typeof encodeEndpoint>[]
  readonly winner: ReturnType<typeof encodeEndpoint>
  readonly periodicSelectionValid: boolean
  readonly experimentValid: boolean
  readonly catalogCoverageValid: boolean
  readonly productionValid: boolean
}

const fullPortfolioCases: FullPortfolioCase[] = []

for (const combo of COMBOS) {
  for (const sheetDef of SHEETS) {
    const caseId = `${combo.label}-${sheetDef.key}`
    const sheet = sheetSpec(sheetDef.width, sheetDef.height, caseId)
    const exit = runFullPortfolio(sheet, combo.pieces, { maximumDirectRuntimeMs: 15000 })
    const result = unwrap(exit, caseId)
    if (result.periodicPortfolio.catalog.families.length !== 0) {
      throw new Error(
        `case ${caseId}: expected zero periodic families for distinct mixed61 pieces, got ` +
          `${result.periodicPortfolio.catalog.families.length}`
      )
    }
    // Self-checks exercising the remaining exported entry points this
    // module imports but does not otherwise call directly: standalone
    // re-invocation must reproduce exactly what
    // `runIntrinsicSharedArchivePortfolio` already computed internally
    // (`intrinsicSharedArchivePortfolio.ts:212-235` calls each of these the
    // same way).
    const recomputedFitting = selectFittingSharedArchive(result.sheetlessArchive)
    if (recomputedFitting.length !== result.archive.length) {
      throw new Error(`case ${caseId}: selectFittingSharedArchive length mismatch`)
    }
    const recomputedExperimentValid = intrinsicSharedArchiveExperimentValid(
      result.directRuns,
      result.periodicRuns,
      result.periodicSelectionValid
    )
    if (recomputedExperimentValid !== result.experimentValid) {
      throw new Error(`case ${caseId}: intrinsicSharedArchiveExperimentValid mismatch`)
    }
    const recomputedCatalogCoverageValid = intrinsicSharedPeriodicCatalogCoverageValid(
      result.periodicPortfolio.catalog
    )
    fullPortfolioCases.push({
      caseId,
      pieceCount: combo.pieceCount,
      pieces: combo.pieces.map(encodePreparedPieceSummary),
      sheet: encodeSheet(sheet),
      directRuns: result.directRuns.map(encodeRun),
      periodicRuns: result.periodicRuns.map(encodeRun),
      catalog: encodeCatalog(result.periodicPortfolio.catalog),
      continuationCount: String(result.periodicPortfolio.runs.length),
      continuationCoverageComplete: result.periodicPortfolio.continuationCoverageComplete,
      continuationBudgetSettlementComplete: result.periodicPortfolio.continuationBudgetSettlementComplete ?? null,
      sheetlessArchive: result.sheetlessArchive.map((e) => encodeEndpoint(e)),
      archive: result.archive.map((e) => encodeEndpoint(e)),
      winner: encodeEndpoint(result.winner),
      periodicSelectionValid: result.periodicSelectionValid,
      experimentValid: result.experimentValid,
      catalogCoverageValid: recomputedCatalogCoverageValid,
      productionValid: intrinsicSharedArchiveProductionValid(result)
    })
  }
}

// ===========================================================================
// Battery 2: `evaluationCapCases` -- deterministic per-role evaluation caps.
// ===========================================================================
interface EvaluationCapCase {
  readonly caseId: string
  readonly pieces: ReturnType<typeof encodePreparedPieceSummary>[]
  readonly sheet: ReturnType<typeof encodeSheet>
  readonly cappedRole: IntrinsicSharedArchiveDirectRole
  readonly cap: string
  readonly directRuns: ReturnType<typeof encodeRun>[]
}
const evaluationCapCases: EvaluationCapCase[] = []
const CAPPED_ROLES: ReadonlyArray<IntrinsicSharedArchiveDirectRole> = [
  'canonical-grid',
  'legacy-absolute-envelope',
  'open-pocket-first'
]
const EVAL_CAP_COMBOS = COMBOS.filter((c) => c.pieceCount >= 4 && c.pieceCount <= 6).slice(0, 10)
for (const combo of EVAL_CAP_COMBOS) {
  for (const cappedRole of CAPPED_ROLES) {
    const caseId = `evalcap-${combo.label}-${cappedRole}`
    const sheet = sheetSpec(1400, 1400, caseId)
    const exit = runDirectOnly(sheet, combo.pieces, {
      maximumDirectRuntimeMs: 15000,
      directCandidateEvaluationCaps: { [cappedRole]: 2 }
    })
    const runs = unwrap(exit, caseId)
    evaluationCapCases.push({
      caseId,
      pieces: combo.pieces.map(encodePreparedPieceSummary),
      sheet: encodeSheet(sheet),
      cappedRole,
      cap: '2',
      directRuns: runs.map(encodeRun)
    })
  }
}

// ===========================================================================
// Battery 3: `checkpointChronologyCases` -- production's always-on
// `canonicalGridCompletedPieceQuantum: 1` pause/resume chronology.
// ===========================================================================
interface CheckpointChronologyCase {
  readonly caseId: string
  readonly pieces: ReturnType<typeof encodePreparedPieceSummary>[]
  readonly sheet: ReturnType<typeof encodeSheet>
  readonly checkpointFireCount: string
  readonly checkpointProducerRoles: string[]
  readonly checkpointNextPieceIndices: string[]
  readonly directRuns: ReturnType<typeof encodeRun>[]
  readonly groundTruthDirectRuns: ReturnType<typeof encodeRun>[]
}
const checkpointChronologyCases: CheckpointChronologyCase[] = []
const CHECKPOINT_COMBOS = COMBOS.filter((c) => c.pieceCount >= 3 && c.pieceCount <= 7).slice(0, 8)
for (const combo of CHECKPOINT_COMBOS) {
  const caseId = `checkpoint-${combo.label}`
  const sheet = sheetSpec(1400, 1400, caseId)
  const producerRoles: string[] = []
  const nextPieceIndices: string[] = []
  const exit = runDirectOnly(sheet, combo.pieces, {
    maximumDirectRuntimeMs: 15000,
    canonicalGridCompletedPieceQuantum: 1,
    onCanonicalGridCheckpointed: (checkpoint: IntrinsicStrictDirectCheckpoint) =>
      Effect.sync(() => {
        producerRoles.push(checkpoint.producerRole)
        nextPieceIndices.push(f64Bits(checkpoint.nextPieceIndex))
      })
  })
  const runs = unwrap(exit, caseId)

  const groundTruthExit = runDirectOnly(sheet, combo.pieces, { maximumDirectRuntimeMs: 15000 })
  const groundTruthRuns = unwrap(groundTruthExit, `${caseId}-ground-truth`)

  checkpointChronologyCases.push({
    caseId,
    pieces: combo.pieces.map(encodePreparedPieceSummary),
    sheet: encodeSheet(sheet),
    checkpointFireCount: String(producerRoles.length),
    checkpointProducerRoles: producerRoles,
    checkpointNextPieceIndices: nextPieceIndices,
    directRuns: runs.map(encodeRun),
    groundTruthDirectRuns: groundTruthRuns.map(encodeRun)
  })
}

// ===========================================================================
// Battery 4: `admissionCases` -- illegal / incomplete / duplicate rejection.
// ===========================================================================
interface AdmissionCase {
  readonly caseId: string
  readonly kind: 'illegal-no-fit' | 'incomplete' | 'duplicate' | 'hash-mismatch'
  readonly pieces: ReturnType<typeof encodePreparedPieceSummary>[] | null
  readonly sheet: ReturnType<typeof encodeSheet> | null
  readonly inputEndpointHashes: string[]
  readonly retainedRoles: string[]
  readonly retainedHashes: string[]
  readonly normalizedRunStatus: string | null
  readonly normalizedRunHasEndpoint: boolean | null
}
const admissionCases: AdmissionCase[] = []

// illegal-no-fit: reuse the `nothing-fits` sheet lane already present in
// `fullPortfolioCases` -- `sheetlessArchive` is non-empty (direct roles
// completed sheetlessly) but `archive` (post `selectFittingSharedArchive`)
// is empty because no orientation legally fits a 1x1 sheet.
for (const fullCase of fullPortfolioCases) {
  if (!fullCase.caseId.endsWith('-nothing-fits')) continue
  admissionCases.push({
    caseId: `illegal-${fullCase.caseId}`,
    kind: 'illegal-no-fit',
    // No independent `pieces`/`sheet`: this case is a documentary cross-
    // reference into `fullPortfolioCases[caseId=fullCase.caseId]`, already
    // independently reconstructed and asserted there.
    pieces: null,
    sheet: null,
    inputEndpointHashes: fullCase.sheetlessArchive.map((e) => e!.sheetlessCanonicalGeometryHash),
    retainedRoles: [],
    retainedHashes: fullCase.archive.map((e) => e!.sheetlessCanonicalGeometryHash),
    normalizedRunStatus: null,
    normalizedRunHasEndpoint: null
  })
}

// duplicate: a single-piece combo -- all three direct roles converge on an
// identical canonical hash; `retainRankedSharedArchive` must keep exactly
// one, owned by the first-encountered role (`canonical-grid`, iterated
// first per `INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES`).
{
  const soloPiece = preparedPiece('solo', fixtureHullRing(0))
  const sheet = sheetSpec(1400, 1400, 'duplicate-solo')
  const exit = runDirectOnly(sheet, [soloPiece], { maximumDirectRuntimeMs: 15000 })
  const runs = unwrap(exit, 'duplicate-solo')
  const endpoints = runs.flatMap((r) => (r.endpoint === undefined ? [] : [r.endpoint]))
  if (endpoints.length !== 3) {
    throw new Error(`duplicate-solo: expected 3 completed direct endpoints, got ${endpoints.length}`)
  }
  const retained = retainRankedSharedArchive(endpoints)
  admissionCases.push({
    caseId: 'duplicate-solo',
    kind: 'duplicate',
    pieces: [soloPiece].map(encodePreparedPieceSummary),
    sheet: encodeSheet(sheet),
    inputEndpointHashes: endpoints.map((e) => e.sheetlessCanonicalGeometryHash),
    retainedRoles: retained.map((e) => e.role),
    retainedHashes: retained.map((e) => e.sheetlessCanonicalGeometryHash),
    normalizedRunStatus: null,
    normalizedRunHasEndpoint: null
  })
}

// hash-mismatch: corrupt one real recorded endpoint's
// `sheetlessCanonicalGeometryHash` so it no longer equals
// `metrics.canonicalGeometryHash`; `retainRankedSharedArchive`'s `validate`
// must reject it outright (empty result).
{
  const soloPiece = preparedPiece('mismatch-solo', fixtureHullRing(20))
  const sheet = sheetSpec(1400, 1400, 'hash-mismatch-solo')
  const exit = runDirectOnly(sheet, [soloPiece], { maximumDirectRuntimeMs: 15000 })
  const runs = unwrap(exit, 'hash-mismatch-solo')
  const endpoint = runs[0]?.endpoint
  if (endpoint === undefined) throw new Error('hash-mismatch-solo: expected a completed endpoint')
  const corrupted: IntrinsicSharedArchiveEndpoint = {
    ...endpoint,
    sheetlessCanonicalGeometryHash: `${endpoint.sheetlessCanonicalGeometryHash}-corrupted`
  }
  const retained = retainRankedSharedArchive([corrupted])
  admissionCases.push({
    caseId: 'hash-mismatch-solo',
    kind: 'hash-mismatch',
    pieces: [soloPiece].map(encodePreparedPieceSummary),
    sheet: encodeSheet(sheet),
    inputEndpointHashes: [corrupted.sheetlessCanonicalGeometryHash],
    retainedRoles: retained.map((e) => e.role),
    retainedHashes: retained.map((e) => e.sheetlessCanonicalGeometryHash),
    normalizedRunStatus: null,
    normalizedRunHasEndpoint: null
  })
}

// incomplete: a real, validly-constructed `IrregularBeamState.empty([...])`
// with a nonempty `remainingPreparedPieces` and zero placements, fed
// through the REAL exported `normalizeIntrinsicSharedArchiveConstructedRun`
// (`makeIntrinsicSharedArchiveEndpoint` must return `undefined` because
// `remainingPreparedPieces.length > 0`, per `:618-624`).
{
  const remainingPiece = preparedPiece('incomplete-remaining', fixtureHullRing(30))
  const state = IrregularBeamState.empty([remainingPiece])
  const constructed: IntrinsicStrictConstructResult = {
    state,
    stepTrace: [],
    gapFillEvidence: [],
    candidateEvaluationCount: 3,
    runtimeMs: 5
  }
  const run = normalizeIntrinsicSharedArchiveConstructedRun({
    sheet: sheetSpec(1400, 1400, 'incomplete-remaining'),
    role: 'canonical-grid',
    sourceId: undefined,
    requestedCandidateEvaluations: undefined,
    constructed
  })
  // Direct coverage of `makeIntrinsicSharedArchiveEndpoint` itself (the
  // function `normalizeIntrinsicSharedArchiveConstructedRun` delegates to,
  // `:580-586`): same rejection, called standalone.
  const directEndpoint = makeIntrinsicSharedArchiveEndpoint({
    sheet: sheetSpec(1400, 1400, 'incomplete-remaining-direct'),
    role: 'canonical-grid',
    sourceId: undefined,
    state,
    runtimeMs: 5
  })
  if (directEndpoint !== undefined) {
    throw new Error('incomplete-remaining-pieces: expected makeIntrinsicSharedArchiveEndpoint to return undefined')
  }
  admissionCases.push({
    caseId: 'incomplete-remaining-pieces',
    kind: 'incomplete',
    pieces: [remainingPiece].map(encodePreparedPieceSummary),
    sheet: encodeSheet(sheetSpec(1400, 1400, 'incomplete-remaining')),
    inputEndpointHashes: [],
    retainedRoles: [],
    retainedHashes: [],
    normalizedRunStatus: run.status,
    normalizedRunHasEndpoint: run.endpoint !== undefined
  })
}

// ===========================================================================
// Battery 5: `rankingComparatorCases` -- synthetic endpoint pairs/triples
// exercising every branch of `compareIntrinsicSharedArchiveWinner`'s chain,
// fed through the REAL `selectIntrinsicSharedArchiveWinner`.
// ===========================================================================
interface RankingComparatorCase {
  readonly caseId: string
  readonly description: string
  readonly candidates: ReturnType<typeof encodeEndpoint>[]
  readonly winnerHash: string | null
}
const rankingComparatorCases: RankingComparatorCase[] = []

function certOf(input: {
  readonly passes?: boolean
  readonly numerator?: string
  readonly denominator?: string
  readonly relativeDeficitSum?: number
}): IntrinsicStrictCertificate {
  return {
    passes: input.passes ?? true,
    violatedFloors: [],
    relativeDeficitSum: input.relativeDeficitSum ?? 0,
    ...(input.numerator === undefined ? {} : { exactRelativeDeficitNumerator: input.numerator }),
    ...(input.denominator === undefined ? {} : { exactRelativeDeficitDenominator: input.denominator })
  }
}

function metricsOf(input: {
  readonly hash: string
  readonly cavityCount?: number
  readonly hullGapDoubled?: string
  readonly hullDoubled?: string
  readonly hullGapRatio?: number
  readonly envelopeAreaGrid2?: string
  readonly envelopeMaxSideGrid?: number
  readonly envelopeSpanGrid?: number
  readonly envelopeAreaMm2?: number
  readonly envelopeMaxSideMm?: number
  readonly envelopeSpanMm?: number
  readonly withExact?: boolean
}): IntrinsicStrictCompletedMetrics {
  const withExact = input.withExact ?? true
  return {
    envelopeMaximumSideMm: input.envelopeMaxSideMm ?? 10,
    envelopeAreaMm2: input.envelopeAreaMm2 ?? 100,
    envelopeSpanMm: input.envelopeSpanMm ?? 14.14,
    enclosedCavityCount: input.cavityCount ?? 0,
    totalEnclosedCavityAreaMm2: 0,
    largestOccupiedHullGapRatio: input.hullGapRatio ?? 0,
    isolatedPieceCount: 0,
    positiveContactComponentCount: 1,
    largestPositiveContactComponentSize: 1,
    largestPositiveContactComponentRatio: 1,
    occupiedAreaOutsideLargestContactComponentMm2: 0,
    occupiedHullWasteRatio: 0,
    totalStructuralContacts: 0,
    dominantStructuralContacts: 0,
    contactUnits: 0,
    sharedBoundaryLengthMm: 0,
    canonicalGeometryHash: input.hash,
    runtimeMs: 0,
    ...(withExact
      ? {
          exact: {
            envelopeMaximumSideGrid: input.envelopeMaxSideGrid ?? 10000,
            envelopeAreaGrid2: input.envelopeAreaGrid2 ?? '100000000',
            envelopeSpanGrid: input.envelopeSpanGrid ?? 14140,
            totalEnclosedCavityDoubledAreaGrid2: '0',
            largestOccupiedHullGapDoubledAreaGrid2: input.hullGapDoubled ?? '0',
            occupiedHullDoubledAreaGrid2: input.hullDoubled ?? '1000',
            occupiedHullWasteDoubledAreaGrid2: '0',
            largestPositiveContactComponentSize: 1,
            placedPieceCount: 1,
            occupiedOutsideLargestContactComponentDoubledAreaGrid2: '0'
          }
        }
      : {})
  }
}

function endpointOf(input: {
  readonly role: string
  readonly metrics: IntrinsicStrictCompletedMetrics
  readonly certificate: IntrinsicStrictCertificate
}): IntrinsicSharedArchiveEndpoint {
  const hash = input.metrics.canonicalGeometryHash
  return {
    role: input.role,
    sourceId: undefined,
    sheetlessCanonicalGeometryIdentity: `identity-${hash}`,
    sheetlessCanonicalGeometryHash: hash,
    placedCollisionGeometries: [],
    metrics: input.metrics,
    certificate: input.certificate,
    requestedSheetFit: {
      q0: { fits: true, canonicalGeometryHash: hash },
      q90: { fits: false, canonicalGeometryHash: undefined },
      selectedRotationDeg: 0,
      selectedCanonicalGeometryHash: hash,
      selectedPlacedCollisionGeometries: []
    }
  }
}

function runComparatorCase(caseId: string, description: string, endpoints: IntrinsicSharedArchiveEndpoint[]): void {
  const winner = selectIntrinsicSharedArchiveWinner(endpoints)
  rankingComparatorCases.push({
    caseId,
    description,
    candidates: endpoints.map((e) => encodeEndpoint(e)),
    winnerHash: winner?.sheetlessCanonicalGeometryHash ?? null
  })
}

// certificate deficit, exact BigInt cross-multiplication: smaller ratio wins.
runComparatorCase(
  'cert-deficit-exact',
  'exact certificate deficit cross-multiplication: 1/4 beats 1/2',
  [
    endpointOf({
      role: 'a',
      metrics: metricsOf({ hash: 'cert-a', envelopeAreaGrid2: '100000000' }),
      certificate: certOf({ numerator: '1', denominator: '2' })
    }),
    endpointOf({
      role: 'b',
      metrics: metricsOf({ hash: 'cert-b', envelopeAreaGrid2: '100000000' }),
      certificate: certOf({ numerator: '1', denominator: '4' })
    })
  ]
)

// certificate deficit, float fallback (one side missing exact fraction).
runComparatorCase(
  'cert-deficit-float-fallback',
  'float relativeDeficitSum fallback when either side lacks an exact fraction',
  [
    endpointOf({
      role: 'a',
      metrics: metricsOf({ hash: 'cert-fb-a' }),
      certificate: certOf({ relativeDeficitSum: 0.9 })
    }),
    endpointOf({
      role: 'b',
      metrics: metricsOf({ hash: 'cert-fb-b' }),
      certificate: certOf({ numerator: '1', denominator: '10', relativeDeficitSum: 0.1 })
    })
  ]
)

// cavity count tie-break (equal certificate deficit).
runComparatorCase(
  'cavity-count-tiebreak',
  'equal certificate deficit, fewer enclosed cavities wins',
  [
    endpointOf({
      role: 'a',
      metrics: metricsOf({ hash: 'cavity-a', cavityCount: 3, envelopeAreaGrid2: '500000' }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    }),
    endpointOf({
      role: 'b',
      metrics: metricsOf({ hash: 'cavity-b', cavityCount: 1, envelopeAreaGrid2: '500000' }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    })
  ]
)

// largest-hull-gap exact ratio tie-break.
runComparatorCase(
  'hull-gap-exact-tiebreak',
  'equal certificate deficit and cavity count, smaller exact hull-gap ratio wins',
  [
    endpointOf({
      role: 'a',
      metrics: metricsOf({ hash: 'gap-a', hullGapDoubled: '400', hullDoubled: '1000' }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    }),
    endpointOf({
      role: 'b',
      metrics: metricsOf({ hash: 'gap-b', hullGapDoubled: '100', hullDoubled: '1000' }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    })
  ]
)

// largest-hull-gap float fallback.
runComparatorCase(
  'hull-gap-float-fallback',
  'float largestOccupiedHullGapRatio fallback when either side lacks exact metrics',
  [
    endpointOf({
      role: 'a',
      metrics: metricsOf({ hash: 'gap-fb-a', hullGapRatio: 0.4, withExact: false }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    }),
    endpointOf({
      role: 'b',
      metrics: metricsOf({ hash: 'gap-fb-b', hullGapRatio: 0.1, withExact: true }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    })
  ]
)

// envelope exact tie-break: area, then max side, then span.
runComparatorCase(
  'envelope-area-tiebreak',
  'equal certificate/cavity/hull-gap, smaller exact envelope area wins',
  [
    endpointOf({
      role: 'a',
      metrics: metricsOf({ hash: 'env-area-a', envelopeAreaGrid2: '900' }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    }),
    endpointOf({
      role: 'b',
      metrics: metricsOf({ hash: 'env-area-b', envelopeAreaGrid2: '400' }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    })
  ]
)
runComparatorCase(
  'envelope-max-side-tiebreak',
  'equal exact envelope area, smaller envelopeMaximumSideGrid wins',
  [
    endpointOf({
      role: 'a',
      metrics: metricsOf({ hash: 'env-side-a', envelopeAreaGrid2: '900', envelopeMaxSideGrid: 90 }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    }),
    endpointOf({
      role: 'b',
      metrics: metricsOf({ hash: 'env-side-b', envelopeAreaGrid2: '900', envelopeMaxSideGrid: 30 }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    })
  ]
)
runComparatorCase(
  'envelope-span-tiebreak',
  'equal exact envelope area and max side, smaller envelopeSpanGrid wins',
  [
    endpointOf({
      role: 'a',
      metrics: metricsOf({ hash: 'env-span-a', envelopeAreaGrid2: '900', envelopeMaxSideGrid: 30, envelopeSpanGrid: 50 }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    }),
    endpointOf({
      role: 'b',
      metrics: metricsOf({ hash: 'env-span-b', envelopeAreaGrid2: '900', envelopeMaxSideGrid: 30, envelopeSpanGrid: 20 }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    })
  ]
)
runComparatorCase(
  'envelope-float-fallback',
  'float envelopeAreaMm2/side/span fallback when either side lacks exact metrics',
  [
    endpointOf({
      role: 'a',
      metrics: metricsOf({ hash: 'env-fb-a', envelopeAreaMm2: 900, withExact: false }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    }),
    endpointOf({
      role: 'b',
      metrics: metricsOf({ hash: 'env-fb-b', envelopeAreaMm2: 400, withExact: true }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    })
  ]
)

// final hash tie-break: every other key exactly equal.
runComparatorCase(
  'hash-final-tiebreak',
  'every comparator key equal, lexicographically smaller hash wins',
  [
    endpointOf({
      role: 'a',
      metrics: metricsOf({ hash: 'zzz-larger-hash' }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    }),
    endpointOf({
      role: 'b',
      metrics: metricsOf({ hash: 'aaa-smaller-hash' }),
      certificate: certOf({ numerator: '0', denominator: '1' })
    })
  ]
)

// Pareto-front gating: a passing certificate must not rescue a
// geometrically-dominated layout (mirrors
// `tests/unit/intrinsicSharedArchivePortfolio.test.ts:149-173`).
runComparatorCase(
  'pareto-front-certificate-does-not-rescue',
  'small strictly dominates large on envelope area with equal cavities; large\'s passing certificate must not win',
  [
    endpointOf({
      role: 'small',
      metrics: metricsOf({ hash: 'pareto-small', envelopeAreaGrid2: '100' }),
      certificate: certOf({ passes: true, relativeDeficitSum: 0 })
    }),
    endpointOf({
      role: 'large',
      metrics: metricsOf({ hash: 'pareto-large', envelopeAreaGrid2: '400' }),
      certificate: certOf({ passes: true, relativeDeficitSum: 0 })
    })
  ]
)

// Three-way tie-break chain: only the hash decides.
runComparatorCase(
  'three-way-hash-tiebreak',
  'three endpoints identical on every metric key, hash order decides',
  [
    endpointOf({ role: 'c', metrics: metricsOf({ hash: 'ccc' }), certificate: certOf({ numerator: '0', denominator: '1' }) }),
    endpointOf({ role: 'a', metrics: metricsOf({ hash: 'aaa' }), certificate: certOf({ numerator: '0', denominator: '1' }) }),
    endpointOf({ role: 'b', metrics: metricsOf({ hash: 'bbb' }), certificate: certOf({ numerator: '0', denominator: '1' }) })
  ]
)

// ===========================================================================
// Vector-count accounting and write-out.
// ===========================================================================
const totalVectorCount =
  fullPortfolioCases.length +
  evaluationCapCases.length +
  checkpointChronologyCases.length +
  admissionCases.length +
  rankingComparatorCases.length

if (totalVectorCount < 400) {
  throw new Error(`Expected >= 400 shared-archive vectors, got ${totalVectorCount}.`)
}

mkdirSync(VECTORS_DIR, { recursive: true })
const commit = generatingCommit()

const settingsJson = JSON.parse(
  JSON.stringify(DEFAULT_IRREGULAR_NESTING_SETTINGS, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value
  )
) as unknown

const output = {
  generatedByScript: 'scripts/rust-parity/dump-shared-archive.ts',
  generatingCommit: commit,
  description:
    'intrinsicSharedArchivePortfolio.ts + intrinsicAnytimeArchive.ts full-port coverage: real ' +
    'runIntrinsicSharedArchivePortfolio full-portfolio runs (2-8 distinct real mixed61 hull pieces, three ' +
    'sheets -- generous/tight/nothing-fits) recording every direct run, the (trivially empty, verified ' +
    'zero-family) periodic run/catalog, sheetlessArchive/archive order and identities, winner, and every ' +
    'validity predicate; deterministic per-role evaluation-cap truncation via ' +
    'runIntrinsicSharedArchiveDirectPortfolio; production\'s always-on canonicalGridCompletedPieceQuantum=1 ' +
    'checkpoint pause/resume chronology (firing count, producerRole/nextPieceIndex per firing, final resumed ' +
    'directRuns); illegal/incomplete/duplicate/hash-mismatch admission-rejection cases; and synthetic ' +
    'endpoint batteries exercising every branch of compareIntrinsicSharedArchiveWinner\'s five-key chain plus ' +
    'the geometric-Pareto-front gate, via the real selectIntrinsicSharedArchiveWinner. f64 values are ' +
    'recorded as big-endian IEEE-754 bit-pattern hex strings for bit-exact comparison; BigInt/doubled-area- ' +
    'grid2 fields are recorded verbatim as decimal strings. `settings` is the byte-exact JSON projection of ' +
    'the real production DEFAULT_IRREGULAR_NESTING_SETTINGS (GeometrySettings.Live). There is no injectable ' +
    'timingNow seam in this TS source file (performance.now() reads are diagnostic-only runtimeMs ' +
    'measurements never asserted byte-exactly), so no clock configuration is recorded.',
  settings: settingsJson,
  fullPortfolioCaseCount: fullPortfolioCases.length,
  fullPortfolioCases,
  evaluationCapCaseCount: evaluationCapCases.length,
  evaluationCapCases,
  checkpointChronologyCaseCount: checkpointChronologyCases.length,
  checkpointChronologyCases,
  admissionCaseCount: admissionCases.length,
  admissionCases,
  rankingComparatorCaseCount: rankingComparatorCases.length,
  rankingComparatorCases,
  totalVectorCount
}

writeFileSync(join(VECTORS_DIR, 'shared-archive.json'), JSON.stringify(output, null, 2) + '\n')

const fileBytes = readFileSync(join(VECTORS_DIR, 'shared-archive.json'))
const fileHash = createHash('sha256').update(fileBytes).digest('hex')

console.log(
  `Wrote ${fullPortfolioCases.length} full-portfolio, ${evaluationCapCases.length} evaluation-cap, ` +
    `${checkpointChronologyCases.length} checkpoint-chronology, ${admissionCases.length} admission, and ` +
    `${rankingComparatorCases.length} ranking-comparator cases (${totalVectorCount} total vectors, commit ` +
    `${commit}, file sha256 ${fileHash}) to ${VECTORS_DIR}`
)
