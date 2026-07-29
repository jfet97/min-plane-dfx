/**
 * Differential-vector generator for
 * `crates/irregular-nesting-native/src/archive/periodic_cells.rs` and
 * `crates/irregular-nesting-native/src/archive/periodic_family.rs`.
 *
 * Imports the REAL production TS entry points from
 * `src/workers/algorithm/irregular/intrinsicPeriodicCells.ts` --
 *   `enumerateIntrinsicPeriodicCells`, `compareIntrinsicPeriodicSeedEnvelope`,
 *   `compareIntrinsicPeriodicSeedEnvelopeAreaFirst`, `rankIntrinsicPeriodicSeeds`,
 *   `nonDominatedIntrinsicPeriodicSeeds`, `selectIntrinsicPeriodicSeedFront`
 * -- and `src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.ts` --
 *   `runIntrinsicPeriodicFamilyPortfolio`, `orderPeriodicContinuationsForExecution`,
 *   `continuationsForExecution`, `phaseResidualCoverageComplete`
 * -- evaluated (where Effect-returning) through the REAL Effect service layer
 * stack (`GeometryKernel.Live`, `GeometrySettings.Live`, `NfpIfpServiceLive`),
 * the same shape `dump-reconstruction.ts`/`dump-strict-decoder.ts`/
 * `dump-capacity-search.ts` already establish, driven with
 * `Effect.runSyncExit`.
 *
 * Real mixed61 fixture-piece convex hulls (duplicated to form repeated-piece
 * "families", `groupIntrinsicCollisionFamilies` semantics) plus small
 * hand-built axis-aligned rectangles (also duplicated) form every prepared
 * piece set, mirroring `dump-reconstruction.ts`'s own technique.
 *
 * Determinism: neither `enumerateIntrinsicPeriodicCells` nor
 * `runIntrinsicPeriodicFamilyPortfolio` has an injectable `timingNow` seam in
 * TS (both call the real global `performance.now()` directly, matching the
 * Rust port's own top-doc design note) -- every case below therefore either
 * (a) uses generous runtime budgets far beyond what these tiny fixtures need
 * (deterministic-by-headroom on any reasonably fast machine, the same
 * technique `dump-reconstruction.ts` documents), or (b) uses
 * `maximumTotalRuntimeMs: 0` for a deliberate, deterministic-regardless-of-
 * wall-clock global-deadline case. `runtimeMs`/phase-timing fields are never
 * recorded (diagnostic-only, out of the parity contract per characterization
 * §3).
 *
 * Sections (each independently contributes to the total asserted below):
 *   A. `IntrinsicPeriodicSeed` comparator/ranking pure sweep:
 *      `compareIntrinsicPeriodicSeedEnvelope`/`...AreaFirst` pairwise sign
 *      matrix, `rankIntrinsicPeriodicSeeds`/`nonDominatedIntrinsicPeriodicSeeds`/
 *      `selectIntrinsicPeriodicSeedFront` over several synthetic seed
 *      batteries (component/isolated/largest-component/exact-vs-float
 *      envelope fallback combinations, including the mixed-exact-presence
 *      dominance-is-false rule).
 *   B. `orderPeriodicContinuationsForExecution`/`continuationsForExecution`/
 *      `phaseResidualCoverageComplete` pure sweep over synthetic
 *      continuation batteries (placement-count and `sourceId` tie-breaks).
 *   C. `enumerateIntrinsicPeriodicCells` end-to-end catalog cases over real
 *      rectangle and mixed61-hull repeated-piece sets, sweeping
 *      `maximumCellsPerFamilyRole`/`captureSourceSurvivalAudit`, recording
 *      per-family cell roles/counts/`canonicalKey`s/exact
 *      `determinantGrid2`/`memberDoubledAreaGrid2` strings and coverage
 *      flags.
 *   D. `runIntrinsicPeriodicFamilyPortfolio` end-to-end cases over the same
 *      piece sets, sweeping `maximumContinuationCount`,
 *      `maximumContinuationCandidateEvaluations`,
 *      `admitSourceAuditWitnesses`/`captureSourceSurvivalAudit`,
 *      `sourceAuditScope`, `basisSourceKey`, and one `maximumTotalRuntimeMs:
 *      0` global-deadline case, recording continuations, omissions,
 *      `sourceCropSurvival`, `sourceAuditWitnesses`, run statuses +
 *      `canonicalGeometryHash`, archive hashes, and the winner's `sourceId`.
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-periodic.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/periodic.json
 */
import { Effect } from 'effect'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SheetSpec } from '@shared/domain/nesting.js'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransformCandidate
} from '@shared/irregular/domain.js'
import { computeConvexHull } from '../../src/workers/irregular/core/convexHullCore.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import {
  enumerateIntrinsicPeriodicCells,
  compareIntrinsicPeriodicSeedEnvelope,
  compareIntrinsicPeriodicSeedEnvelopeAreaFirst,
  rankIntrinsicPeriodicSeeds,
  nonDominatedIntrinsicPeriodicSeeds,
  selectIntrinsicPeriodicSeedFront,
  type IntrinsicPeriodicCatalog,
  type IntrinsicPeriodicSeed
} from '../../src/workers/algorithm/irregular/intrinsicPeriodicCells.js'
import {
  runIntrinsicPeriodicFamilyPortfolio,
  orderPeriodicContinuationsForExecution,
  continuationsForExecution,
  phaseResidualCoverageComplete,
  type IntrinsicPeriodicContinuation,
  type IntrinsicPeriodicFamilyPortfolioResult
} from '../../src/workers/algorithm/irregular/intrinsicPeriodicFamilyPortfolio.js'

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

// ---------------------------------------------------------------------------
// Domain-object construction helpers (mirror `dump-reconstruction.ts`'s own
// identically-named helpers; each dump script is deliberately self-contained
// per that script's own established convention).
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
        mirrored: false,
        reason: 'configured'
      })
    )
  }
  return out
}
function preparedPiece(
  id: string,
  points: ReadonlyArray<IrregularPoint>,
  transformCount = 2
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
function preparedRect(id: string, width: number, height: number, transformCount = 2): IrregularPreparedPiece {
  return preparedPiece(id, rectanglePoints(width, height), transformCount)
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
function runCatalog(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  options: Parameters<typeof enumerateIntrinsicPeriodicCells>[1]
) {
  return Effect.runSyncExit(
    enumerateIntrinsicPeriodicCells(pieces, options).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
}
function runPortfolio(
  archiveSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  options: Parameters<typeof runIntrinsicPeriodicFamilyPortfolio>[2]
) {
  return Effect.runSyncExit(
    runIntrinsicPeriodicFamilyPortfolio(archiveSheet, pieces, options).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

// ---------------------------------------------------------------------------
// Encoding helpers.
// ---------------------------------------------------------------------------
function encodePreparedForCase(pieces: ReadonlyArray<IrregularPreparedPiece>) {
  return pieces.map((p) => ({
    pieceId: (p.pieceId ?? p.source.id) as string,
    points: p.collisionGeometry.collisionPolygon.points.map((pt) => ({
      x: f64Bits(pt.x),
      y: f64Bits(pt.y)
    })),
    transforms: p.transforms.map((t) => ({
      index: f64Bits(t.index),
      rotationDeg: f64Bits(t.rotationDeg),
      mirrored: t.mirrored,
      reason: t.reason
    })),
    allowMirror: p.allowMirror
  }))
}

function encodeCatalog(catalog: IntrinsicPeriodicCatalog) {
  return {
    familyCoverageComplete: catalog.familyCoverageComplete,
    runtimeCoverageComplete: catalog.runtimeCoverageComplete,
    selectedFamilyKey: catalog.selectedFamilyKey ?? null,
    families: catalog.families.map((family) => ({
      familyKey: family.familyKey,
      memberCount: f64Bits(family.memberCount),
      uniqueTransformCount: f64Bits(family.uniqueTransformCount),
      retainedTransformCount: f64Bits(family.retainedTransformCount),
      transformCoverageComplete: family.transformCoverageComplete,
      enumeratedPairCount: f64Bits(family.enumeratedPairCount),
      pairCoverageComplete: family.pairCoverageComplete,
      cellCoverageComplete: family.cellCoverageComplete,
      cells: family.cells.map((cell) => ({
        role: cell.role,
        determinantGrid2: cell.determinantGrid2,
        memberDoubledAreaGrid2: cell.memberDoubledAreaGrid2,
        envelopeMaximumSideMm: f64Bits(cell.envelopeMaximumSideMm),
        hullWasteRatio: f64Bits(cell.hullWasteRatio),
        sharedBoundaryLengthMm: f64Bits(cell.sharedBoundaryLengthMm),
        infiniteFarProof: cell.infiniteFarProof,
        threeByThreeLatticeLegal: cell.threeByThreeLatticeLegal,
        threeByThreeCentreContactComplete: cell.threeByThreeCentreContactComplete,
        basisSourceKind: cell.basisProvenance?.sourceKind ?? null,
        basisSourceKey: cell.basisProvenance?.sourceKey ?? null,
        canonicalKey: cell.canonicalKey
      })),
      rejected: family.rejected,
      sourceSurvivalCount: family.sourceSurvival.length
    })),
    cellCount: catalog.cells.length,
    rejected: catalog.rejected
  }
}

function encodeSourceId(continuation: IntrinsicPeriodicContinuation): string {
  return continuation.sourceId
}

function encodePortfolioResult(result: IntrinsicPeriodicFamilyPortfolioResult) {
  return {
    catalogFamilyCount: result.catalog.families.length,
    continuations: result.continuations.map((c) => ({
      sourceId: c.sourceId,
      role: c.role,
      familyKey: c.familyKey,
      cellKey: c.cellKey,
      basisSourceKey: c.basisSourceKey ?? null,
      placementCount: f64Bits(c.seed.placements.length),
      canonicalKey: c.seed.canonicalKey
    })),
    continuationOmissions: result.continuationOmissions.map((o) => ({
      sourceId: o.sourceId,
      reason: o.reason
    })),
    continuationCoverageComplete: result.continuationCoverageComplete,
    continuationExecutionCoverageComplete: result.continuationExecutionCoverageComplete,
    continuationBudgetSettlementComplete: result.continuationBudgetSettlementComplete,
    sourceCropSurvival: result.sourceCropSurvival.map((s) => ({
      role: s.role,
      sourceKey: s.sourceKey,
      sourceKind: s.sourceKind,
      retainedCellCount: f64Bits(s.retainedCellCount),
      directValidCropCountBeforeFront: f64Bits(s.directValidCropCountBeforeFront),
      directValidCropCount: f64Bits(s.directValidCropCount),
      cropFrontCount: f64Bits(s.cropFrontCount),
      uniqueSeedCount: f64Bits(s.uniqueSeedCount),
      selectedContinuationCount: f64Bits(s.selectedContinuationCount)
    })),
    sourceAuditWitnessCount: result.sourceAuditWitnesses.length,
    sourceAuditWitnessSourceIds: result.sourceAuditWitnesses.map(
      (w) => `${w.role}:${w.sourceKey}:${w.cellKey}`
    ),
    sourceAuditNonDominatedCropCount: f64Bits(result.sourceAuditNonDominatedCropCount),
    sourceAuditReplayAccepted: result.sourceAuditReplayAccepted,
    runStatuses: result.runs.map((run) => ({
      sourceId: run.continuation.sourceId,
      status: run.status,
      canonicalGeometryHash: run.result?.metrics?.canonicalGeometryHash ?? null
    })),
    archiveHashes: result.archive.map((m) => m.canonicalGeometryHash),
    winnerSourceId: result.winner?.continuation.sourceId ?? null
  }
}

// =============================================================================
// Synthetic `IntrinsicPeriodicSeed` builder (Section A/B do not need real
// geometry -- every comparator/ranking function under test here only reads
// `componentCount`/`isolatedPieceCount`/`largestComponentSize`/
// `maximumSideMm`/`envelopeAreaMm2`/`envelopeSpanMm`/`exactEnvelope`/
// `canonicalKey`).
// =============================================================================
interface SyntheticSeedSpec {
  readonly canonicalKey: string
  readonly componentCount: number
  readonly isolatedPieceCount: number
  readonly largestComponentSize: number
  readonly maximumSideMm: number
  readonly envelopeAreaMm2: number
  readonly envelopeSpanMm: number
  readonly exact?: { readonly maximumSideGrid: number; readonly areaGrid2: string; readonly spanGrid: number }
}
function syntheticSeed(spec: SyntheticSeedSpec): IntrinsicPeriodicSeed {
  return {
    role: 'P1',
    cellKey: `cell-${spec.canonicalKey}`,
    placements: [],
    remainingFamilyMembers: [],
    componentCount: spec.componentCount,
    isolatedPieceCount: spec.isolatedPieceCount,
    largestComponentSize: spec.largestComponentSize,
    maximumSideMm: spec.maximumSideMm,
    envelopeAreaMm2: spec.envelopeAreaMm2,
    envelopeSpanMm: spec.envelopeSpanMm,
    ...(spec.exact === undefined
      ? {}
      : {
          exactEnvelope: {
            maximumSideGrid: spec.exact.maximumSideGrid,
            areaGrid2: spec.exact.areaGrid2,
            spanGrid: spec.exact.spanGrid
          }
        }),
    crop: { rows: 1, columns: 1, traversal: 'row', corner: 0 },
    canonicalKey: spec.canonicalKey
  }
}
function encodeSyntheticSeed(seed: IntrinsicPeriodicSeed) {
  return {
    canonicalKey: seed.canonicalKey,
    componentCount: f64Bits(seed.componentCount),
    isolatedPieceCount: f64Bits(seed.isolatedPieceCount),
    largestComponentSize: f64Bits(seed.largestComponentSize),
    maximumSideMm: f64Bits(seed.maximumSideMm),
    envelopeAreaMm2: f64Bits(seed.envelopeAreaMm2),
    envelopeSpanMm: f64Bits(seed.envelopeSpanMm),
    exact:
      seed.exactEnvelope === undefined
        ? null
        : {
            maximumSideGrid: f64Bits(seed.exactEnvelope.maximumSideGrid),
            areaGrid2: seed.exactEnvelope.areaGrid2,
            spanGrid: f64Bits(seed.exactEnvelope.spanGrid)
          }
  }
}

// =============================================================================
// Section A: comparator/ranking pure sweep.
// =============================================================================
interface SeedBatteryCase {
  readonly caseId: string
  readonly seeds: ReturnType<typeof encodeSyntheticSeed>[]
  readonly compareEnvelopeSigns: number[]
  readonly compareEnvelopeAreaFirstSigns: number[]
  readonly rankedCanonicalKeys: string[]
  readonly nonDominatedCanonicalKeys: string[]
  readonly frontCanonicalKeys: string[]
}
const seedBatteryCases: SeedBatteryCase[] = []
const SEED_BATTERIES: ReadonlyArray<{ readonly caseId: string; readonly specs: SyntheticSeedSpec[] }> = [
  {
    caseId: 'component-and-isolation-spread',
    specs: [
      { canonicalKey: 'a', componentCount: 1, isolatedPieceCount: 0, largestComponentSize: 4, maximumSideMm: 10, envelopeAreaMm2: 100, envelopeSpanMm: 20 },
      { canonicalKey: 'b', componentCount: 2, isolatedPieceCount: 0, largestComponentSize: 3, maximumSideMm: 8, envelopeAreaMm2: 64, envelopeSpanMm: 16 },
      { canonicalKey: 'c', componentCount: 1, isolatedPieceCount: 1, largestComponentSize: 3, maximumSideMm: 9, envelopeAreaMm2: 81, envelopeSpanMm: 18 },
      { canonicalKey: 'd', componentCount: 1, isolatedPieceCount: 0, largestComponentSize: 4, maximumSideMm: 12, envelopeAreaMm2: 90, envelopeSpanMm: 22 }
    ]
  },
  {
    caseId: 'exact-vs-float-fallback',
    specs: [
      { canonicalKey: 'e1', componentCount: 1, isolatedPieceCount: 0, largestComponentSize: 2, maximumSideMm: 10, envelopeAreaMm2: 100, envelopeSpanMm: 20, exact: { maximumSideGrid: 10000, areaGrid2: '100000000', spanGrid: 20000 } },
      { canonicalKey: 'e2', componentCount: 1, isolatedPieceCount: 0, largestComponentSize: 2, maximumSideMm: 10, envelopeAreaMm2: 100, envelopeSpanMm: 20 },
      { canonicalKey: 'e3', componentCount: 1, isolatedPieceCount: 0, largestComponentSize: 2, maximumSideMm: 9, envelopeAreaMm2: 81, envelopeSpanMm: 18, exact: { maximumSideGrid: 9000, areaGrid2: '81000000', spanGrid: 18000 } }
    ]
  },
  {
    caseId: 'dense-tie-chain',
    specs: [
      { canonicalKey: 'z1', componentCount: 1, isolatedPieceCount: 0, largestComponentSize: 5, maximumSideMm: 10, envelopeAreaMm2: 100, envelopeSpanMm: 20 },
      { canonicalKey: 'z2', componentCount: 1, isolatedPieceCount: 0, largestComponentSize: 5, maximumSideMm: 10, envelopeAreaMm2: 100, envelopeSpanMm: 20 },
      { canonicalKey: 'z0', componentCount: 1, isolatedPieceCount: 0, largestComponentSize: 5, maximumSideMm: 10, envelopeAreaMm2: 100, envelopeSpanMm: 20 }
    ]
  },
  {
    caseId: 'six-way-spread',
    specs: [
      { canonicalKey: 'f1', componentCount: 1, isolatedPieceCount: 0, largestComponentSize: 6, maximumSideMm: 5, envelopeAreaMm2: 25, envelopeSpanMm: 10 },
      { canonicalKey: 'f2', componentCount: 1, isolatedPieceCount: 0, largestComponentSize: 5, maximumSideMm: 6, envelopeAreaMm2: 30, envelopeSpanMm: 11 },
      { canonicalKey: 'f3', componentCount: 2, isolatedPieceCount: 0, largestComponentSize: 4, maximumSideMm: 7, envelopeAreaMm2: 35, envelopeSpanMm: 12 },
      { canonicalKey: 'f4', componentCount: 1, isolatedPieceCount: 2, largestComponentSize: 3, maximumSideMm: 8, envelopeAreaMm2: 40, envelopeSpanMm: 13 },
      { canonicalKey: 'f5', componentCount: 3, isolatedPieceCount: 1, largestComponentSize: 2, maximumSideMm: 9, envelopeAreaMm2: 45, envelopeSpanMm: 14 },
      { canonicalKey: 'f6', componentCount: 1, isolatedPieceCount: 0, largestComponentSize: 6, maximumSideMm: 4, envelopeAreaMm2: 20, envelopeSpanMm: 9 }
    ]
  }
]
for (const battery of SEED_BATTERIES) {
  const seeds = battery.specs.map(syntheticSeed)
  const compareEnvelopeSigns: number[] = []
  const compareEnvelopeAreaFirstSigns: number[] = []
  for (let i = 0; i < seeds.length; i++) {
    for (let j = 0; j < seeds.length; j++) {
      compareEnvelopeSigns.push(Math.sign(compareIntrinsicPeriodicSeedEnvelope(seeds[i] as IntrinsicPeriodicSeed, seeds[j] as IntrinsicPeriodicSeed)))
      compareEnvelopeAreaFirstSigns.push(Math.sign(compareIntrinsicPeriodicSeedEnvelopeAreaFirst(seeds[i] as IntrinsicPeriodicSeed, seeds[j] as IntrinsicPeriodicSeed)))
    }
  }
  seedBatteryCases.push({
    caseId: battery.caseId,
    seeds: seeds.map(encodeSyntheticSeed),
    compareEnvelopeSigns,
    compareEnvelopeAreaFirstSigns,
    rankedCanonicalKeys: rankIntrinsicPeriodicSeeds(seeds).map((s) => s.canonicalKey),
    nonDominatedCanonicalKeys: nonDominatedIntrinsicPeriodicSeeds(seeds).map((s) => s.canonicalKey),
    frontCanonicalKeys: selectIntrinsicPeriodicSeedFront(seeds, 2).map((s) => s.canonicalKey)
  })
}

// =============================================================================
// Section B: continuation-execution-ordering pure sweep.
// =============================================================================
interface ContinuationOrderingCase {
  readonly caseId: string
  readonly entries: ReadonlyArray<{
    readonly sourceId: string
    readonly placementCount: number
    readonly maximumSideMm: string
    readonly envelopeAreaMm2: string
    readonly envelopeSpanMm: string
  }>
  readonly orderedSourceIds: string[]
  readonly forExecutionCappedSourceIds: string[]
  readonly forExecutionUncappedSourceIds: string[]
}
function syntheticContinuation(
  sourceId: string,
  placementCount: number,
  spec: SyntheticSeedSpec
): IntrinsicPeriodicContinuation {
  // Always attaches a matching `exact` envelope so `exactEnvelopeForSeed`
  // (`CELLS:849-861`) short-circuits on its first tier without ever reading
  // `seed.placements` -- this section exercises execution-ordering only,
  // not the placements-based envelope re-derivation tier (covered by
  // Section A's real-geometry-free comparator sweep instead), so the
  // `placements` array below is a length-only placeholder.
  const seed = syntheticSeed({
    ...spec,
    exact: spec.exact ?? {
      maximumSideGrid: spec.maximumSideMm * 1000,
      areaGrid2: String(Math.round(spec.envelopeAreaMm2 * 1_000_000)),
      spanGrid: spec.envelopeSpanMm * 1000
    }
  })
  return {
    sourceId,
    role: 'P1',
    familyKey: 'family',
    cellKey: seed.cellKey,
    basisSourceKey: undefined,
    seed: { ...seed, placements: new Array(placementCount).fill(null) as unknown as IrregularPlacedPiece[] }
  }
}
const continuationOrderingCases: ContinuationOrderingCase[] = []
const CONTINUATION_BATTERIES: ReadonlyArray<
  ReadonlyArray<{ readonly sourceId: string; readonly placementCount: number; readonly maximumSideMm: number; readonly envelopeAreaMm2: number; readonly envelopeSpanMm: number }>
> = [
  [
    { sourceId: 'family:P1:cellA:0', placementCount: 4, maximumSideMm: 10, envelopeAreaMm2: 100, envelopeSpanMm: 20 },
    { sourceId: 'family:P1:cellB:0', placementCount: 6, maximumSideMm: 8, envelopeAreaMm2: 64, envelopeSpanMm: 16 },
    { sourceId: 'family:P2:cellC:0', placementCount: 6, maximumSideMm: 8, envelopeAreaMm2: 64, envelopeSpanMm: 16 },
    { sourceId: 'family:P2:cellA:1', placementCount: 4, maximumSideMm: 10, envelopeAreaMm2: 100, envelopeSpanMm: 20 }
  ],
  [
    { sourceId: 'raw-witness:P1:x:1,0:cellZ', placementCount: 4, maximumSideMm: 5, envelopeAreaMm2: 25, envelopeSpanMm: 10 },
    { sourceId: 'other:P1:cellY:0', placementCount: 4, maximumSideMm: 5, envelopeAreaMm2: 25, envelopeSpanMm: 10 }
  ],
  [
    { sourceId: 'solo:P1:cellA:0', placementCount: 4, maximumSideMm: 3, envelopeAreaMm2: 9, envelopeSpanMm: 6 }
  ],
  [
    { sourceId: 'zzz:P1:cellQ:0', placementCount: 4, maximumSideMm: 6, envelopeAreaMm2: 36, envelopeSpanMm: 12 },
    { sourceId: 'aaa:P1:cellQ:1', placementCount: 4, maximumSideMm: 6, envelopeAreaMm2: 36, envelopeSpanMm: 12 },
    { sourceId: 'mmm:P1:cellQ:2', placementCount: 4, maximumSideMm: 6, envelopeAreaMm2: 36, envelopeSpanMm: 12 }
  ],
  [
    { sourceId: 'wide:P1:cellW:0', placementCount: 4, maximumSideMm: 4, envelopeAreaMm2: 12, envelopeSpanMm: 8 },
    { sourceId: 'tall:P1:cellW:1', placementCount: 4, maximumSideMm: 4, envelopeAreaMm2: 20, envelopeSpanMm: 9 },
    { sourceId: 'square:P1:cellW:2', placementCount: 8, maximumSideMm: 4, envelopeAreaMm2: 16, envelopeSpanMm: 8 },
    { sourceId: 'thin:P1:cellW:3', placementCount: 4, maximumSideMm: 4, envelopeAreaMm2: 8, envelopeSpanMm: 8 }
  ]
]
for (const [index, battery] of CONTINUATION_BATTERIES.entries()) {
  const continuations = battery.map((entry) =>
    syntheticContinuation(entry.sourceId, entry.placementCount, {
      canonicalKey: entry.sourceId,
      componentCount: 1,
      isolatedPieceCount: 0,
      largestComponentSize: entry.placementCount,
      maximumSideMm: entry.maximumSideMm,
      envelopeAreaMm2: entry.envelopeAreaMm2,
      envelopeSpanMm: entry.envelopeSpanMm
    })
  )
  continuationOrderingCases.push({
    caseId: `battery-${index}`,
    entries: battery.map((entry) => ({
      sourceId: entry.sourceId,
      placementCount: entry.placementCount,
      maximumSideMm: f64Bits(entry.maximumSideMm),
      envelopeAreaMm2: f64Bits(entry.envelopeAreaMm2),
      envelopeSpanMm: f64Bits(entry.envelopeSpanMm)
    })),
    orderedSourceIds: orderPeriodicContinuationsForExecution(continuations).map(encodeSourceId),
    forExecutionCappedSourceIds: continuationsForExecution(continuations, 1000).map(encodeSourceId),
    forExecutionUncappedSourceIds: continuationsForExecution(continuations, undefined).map(encodeSourceId)
  })
}
interface PhaseResidualCase {
  readonly totalMs: string
  readonly residualMs: string
  readonly complete: boolean
}
const phaseResidualCases: PhaseResidualCase[] = []
const PHASE_RESIDUAL_INPUTS: ReadonlyArray<readonly [number, number]> = [
  [1000, 5],
  [1000, 10],
  [1000, 10.001],
  [1000, 0],
  [0, 0],
  [-1, 0],
  [1000, -1],
  [500, 5.0001],
  [10000, 100],
  [10000, 100.0001],
  [3, 0.03],
  [3, 0.0301],
  [Number.POSITIVE_INFINITY, 1],
  [1000, Number.POSITIVE_INFINITY]
]
for (const [totalMs, residualMs] of PHASE_RESIDUAL_INPUTS) {
  phaseResidualCases.push({
    totalMs: f64Bits(totalMs),
    residualMs: f64Bits(residualMs),
    complete: phaseResidualCoverageComplete(totalMs, residualMs)
  })
}

// =============================================================================
// Section C/D: real repeated-piece sets.
// =============================================================================
interface PieceSetSpec {
  readonly caseId: string
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
}
const pieceSets: PieceSetSpec[] = []
function addRectFamily(caseId: string, width: number, height: number, count: number, transformCount = 2): void {
  pieceSets.push({
    caseId,
    pieces: Array.from({ length: count }, (_, i) => preparedRect(`${caseId}-${i}`, width, height, transformCount))
  })
}
function addHullFamily(caseId: string, hullIndex: number, count: number, transformCount = 2): void {
  pieceSets.push({
    caseId,
    pieces: Array.from({ length: count }, (_, i) => preparedPiece(`${caseId}-${i}`, fixtureHullRing(hullIndex), transformCount))
  })
}
addRectFamily('sq2x2-3', 2, 2, 3)
addRectFamily('sq2x2-4', 2, 2, 4)
addRectFamily('sq2x2-5', 2, 2, 5, 1)
addRectFamily('rect3x2-3', 3, 2, 3)
addRectFamily('rect2x3-6', 2, 3, 6, 4)
addRectFamily('rect4x2-3', 4, 2, 3)
addRectFamily('rect4x4-3', 4, 4, 3)
addRectFamily('rect1x5-4', 1, 5, 4)
addRectFamily('rect3x3-4', 3, 3, 4)
addRectFamily('rect5x2-3', 5, 2, 3, 4)
addRectFamily('rect2x5-3', 2, 5, 3, 1)
addRectFamily('sq3x3-6', 3, 3, 6, 4)
addHullFamily('hull5-2', 5, 2)
addHullFamily('hull12-3', 12, 3)
addHullFamily('hull30-2', 30, 2, 4)
addHullFamily('hull0-3', 0, 3)
addHullFamily('hull20-2', 20, 2)
addHullFamily('hull35-3', 35, 3, 1)
addHullFamily('hull45-2', 45, 2, 4)
addHullFamily('hull55-3', 55, 3)
addHullFamily('hull8-4', 8, 4)
addHullFamily('hull18-2', 18, 2, 4)
// Multi-family: two or three distinct repeated shapes coexist in the same
// job (exercises family selection order, `maximumFamilyCount`, and
// cross-family continuation reservation/fill).
pieceSets.push({
  caseId: 'mixed-two-families',
  pieces: [
    ...Array.from({ length: 3 }, (_, i) => preparedRect(`mixed-sq-${i}`, 2, 2)),
    ...Array.from({ length: 2 }, (_, i) => preparedRect(`mixed-rect-${i}`, 3, 2))
  ]
})
pieceSets.push({
  caseId: 'mixed-three-families',
  pieces: [
    ...Array.from({ length: 3 }, (_, i) => preparedRect(`m3-sq-${i}`, 2, 2)),
    ...Array.from({ length: 2 }, (_, i) => preparedRect(`m3-rect-${i}`, 3, 2)),
    ...Array.from({ length: 2 }, (_, i) => preparedPiece(`m3-hull-${i}`, fixtureHullRing(15)))
  ]
})
addHullFamily('hull58-2', 58, 2, 1)
addRectFamily('sq6x6-3', 6, 6, 3)
pieceSets.push({
  caseId: 'mixed-hull-pair',
  pieces: [
    ...Array.from({ length: 3 }, (_, i) => preparedPiece(`mh-a-${i}`, fixtureHullRing(3))),
    ...Array.from({ length: 3 }, (_, i) => preparedPiece(`mh-b-${i}`, fixtureHullRing(40)))
  ]
})

const CATALOG_OPTION_SWEEPS: ReadonlyArray<{
  readonly label: string
  readonly maximumCellsPerFamilyRole: number
  readonly captureSourceSurvivalAudit: boolean
}> = [
  { label: 'default', maximumCellsPerFamilyRole: 4, captureSourceSurvivalAudit: false },
  { label: 'audit', maximumCellsPerFamilyRole: 4, captureSourceSurvivalAudit: true },
  { label: 'narrow-front', maximumCellsPerFamilyRole: 1, captureSourceSurvivalAudit: false },
  { label: 'wide-front', maximumCellsPerFamilyRole: 16, captureSourceSurvivalAudit: true }
]

interface CatalogCase {
  readonly caseId: string
  readonly sweepLabel: string
  readonly pieces: ReturnType<typeof encodePreparedForCase>
  readonly catalog: ReturnType<typeof encodeCatalog>
}
const catalogCases: CatalogCase[] = []
for (const pieceSet of pieceSets) {
  for (const sweep of CATALOG_OPTION_SWEEPS) {
    const exit = runCatalog(pieceSet.pieces, {
      maximumRuntimeMs: 15_000,
      maximumFamilyCount: 8,
      maximumTransformsPerFamily: 16,
      maximumPairsPerFamily: 120,
      maximumCellsPerFamilyRole: sweep.maximumCellsPerFamilyRole,
      captureSourceSurvivalAudit: sweep.captureSourceSurvivalAudit
    })
    if (exit._tag !== 'Success') {
      throw new Error(`enumerateIntrinsicPeriodicCells failed for ${pieceSet.caseId}/${sweep.label}`)
    }
    catalogCases.push({
      caseId: `${pieceSet.caseId}-${sweep.label}`,
      sweepLabel: sweep.label,
      pieces: encodePreparedForCase(pieceSet.pieces),
      catalog: encodeCatalog(exit.value)
    })
  }
}

const ARCHIVE_SHEET = new SheetSpec({ width: 2000, height: 2000, label: 'periodic-vectors' })
const PORTFOLIO_OPTION_SWEEPS: ReadonlyArray<{
  readonly label: string
  readonly options: Parameters<typeof runIntrinsicPeriodicFamilyPortfolio>[2]
}> = [
  {
    label: 'default',
    options: { maximumContinuationCount: 8, maximumContinuationCandidateEvaluations: 200 }
  },
  {
    label: 'small-cap',
    options: { maximumContinuationCount: 2, maximumContinuationCandidateEvaluations: 50 }
  },
  {
    label: 'audit-admit',
    options: {
      maximumContinuationCount: 8,
      maximumContinuationCandidateEvaluations: 200,
      captureSourceSurvivalAudit: true,
      admitSourceAuditWitnesses: true
    }
  },
  {
    label: 'audit-p2-axis-union',
    options: {
      maximumContinuationCount: 8,
      maximumContinuationCandidateEvaluations: 200,
      captureSourceSurvivalAudit: true,
      admitSourceAuditWitnesses: true,
      sourceAuditScope: 'p2-axis-union'
    }
  },
  {
    label: 'global-deadline',
    options: { maximumContinuationCount: 8, maximumContinuationCandidateEvaluations: 200, maximumTotalRuntimeMs: 0 }
  },
  {
    label: 'uncapped-evaluations',
    options: { maximumContinuationCount: 8 }
  },
  {
    label: 'single-continuation',
    options: { maximumContinuationCount: 1, maximumContinuationCandidateEvaluations: 200 }
  },
  {
    label: 'audit-all-scope',
    options: {
      maximumContinuationCount: 8,
      maximumContinuationCandidateEvaluations: 200,
      captureSourceSurvivalAudit: true,
      admitSourceAuditWitnesses: false,
      sourceAuditScope: 'all'
    }
  },
  {
    label: 'many-crops',
    options: { maximumContinuationCount: 8, maximumContinuationCandidateEvaluations: 200, maximumCropsPerCell: 8 }
  }
]
interface PortfolioCase {
  readonly caseId: string
  readonly sweepLabel: string
  readonly basisSourceKey: string | null
  readonly pieces: ReturnType<typeof encodePreparedForCase>
  readonly result: ReturnType<typeof encodePortfolioResult>
}
const portfolioCases: PortfolioCase[] = []
for (const pieceSet of pieceSets) {
  for (const sweep of PORTFOLIO_OPTION_SWEEPS) {
    const exit = runPortfolio(ARCHIVE_SHEET, pieceSet.pieces, sweep.options)
    if (exit._tag !== 'Success') {
      throw new Error(`runIntrinsicPeriodicFamilyPortfolio failed for ${pieceSet.caseId}/${sweep.label}`)
    }
    portfolioCases.push({
      caseId: `${pieceSet.caseId}-${sweep.label}`,
      sweepLabel: sweep.label,
      basisSourceKey: null,
      pieces: encodePreparedForCase(pieceSet.pieces),
      result: encodePortfolioResult(exit.value)
    })
  }
}
// One `basisSourceKey`-filtered case per hull family whose default-sweep
// catalog produced at least one axis-union-provenanced cell (exercises the
// `basisSourceKey` narrowing option end-to-end).
for (const pieceSet of pieceSets) {
  const exit = runCatalog(pieceSet.pieces, {
    maximumRuntimeMs: 15_000,
    maximumFamilyCount: 8,
    maximumTransformsPerFamily: 16,
    maximumPairsPerFamily: 120,
    maximumCellsPerFamilyRole: 4,
    captureSourceSurvivalAudit: false
  })
  if (exit._tag !== 'Success') continue
  const firstProvenancedCell = exit.value.families
    .flatMap((f) => f.cells)
    .find((cell) => cell.basisProvenance !== undefined)
  if (firstProvenancedCell?.basisProvenance === undefined) continue
  const basisSourceKey = firstProvenancedCell.basisProvenance.sourceKey
  const filteredExit = runPortfolio(ARCHIVE_SHEET, pieceSet.pieces, {
    maximumContinuationCount: 8,
    maximumContinuationCandidateEvaluations: 200,
    basisSourceKey
  })
  if (filteredExit._tag !== 'Success') continue
  portfolioCases.push({
    caseId: `${pieceSet.caseId}-basis-source-key-filtered`,
    sweepLabel: 'basis-source-key-filtered',
    basisSourceKey,
    pieces: encodePreparedForCase(pieceSet.pieces),
    result: encodePortfolioResult(filteredExit.value)
  })
}

// ===========================================================================
// Vector-count accounting and write-out.
// ===========================================================================
const totalVectorCount =
  seedBatteryCases.length +
  continuationOrderingCases.length +
  phaseResidualCases.length +
  catalogCases.length +
  portfolioCases.length

if (totalVectorCount < 300) {
  throw new Error(`Expected >= 300 periodic vectors, got ${totalVectorCount}.`)
}

mkdirSync(VECTORS_DIR, { recursive: true })
const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-periodic.ts',
  generatingCommit: commit,
  description:
    'intrinsicPeriodicCells.ts + intrinsicPeriodicFamilyPortfolio.ts port coverage: (A) ' +
    'IntrinsicPeriodicSeed comparator/ranking pure sweep (compareIntrinsicPeriodicSeedEnvelope[AreaFirst], ' +
    'rankIntrinsicPeriodicSeeds, nonDominatedIntrinsicPeriodicSeeds, selectIntrinsicPeriodicSeedFront, ' +
    'including exact-vs-float envelope fallback and mixed-exact-presence dominance-is-false cases), (B) ' +
    'orderPeriodicContinuationsForExecution/continuationsForExecution/phaseResidualCoverageComplete pure ' +
    'sweep, (C) enumerateIntrinsicPeriodicCells end-to-end catalog cases over real rectangle and mixed61-hull ' +
    'repeated-piece sets, (D) runIntrinsicPeriodicFamilyPortfolio end-to-end cases over the same piece sets ' +
    'sweeping continuation caps, source-survival-audit/witness-admission, sourceAuditScope, basisSourceKey, ' +
    'and one deterministic maximumTotalRuntimeMs: 0 global-deadline case. f64 values are recorded as ' +
    'big-endian IEEE-754 bit-pattern hex strings for bit-exact comparison. Neither entry point has an ' +
    'injectable timingNow seam in TS (real global performance.now() throughout); every case therefore uses ' +
    'either generous runtime headroom (deterministic on any reasonably fast machine) or ' +
    'maximumTotalRuntimeMs: 0 (deterministic regardless of wall-clock speed), and runtimeMs/phase-timing ' +
    'fields are never recorded (diagnostic-only, out of the parity contract).',
  seedBatteryCaseCount: seedBatteryCases.length,
  seedBatteryCases,
  continuationOrderingCaseCount: continuationOrderingCases.length,
  continuationOrderingCases,
  phaseResidualCaseCount: phaseResidualCases.length,
  phaseResidualCases,
  catalogCaseCount: catalogCases.length,
  catalogCases,
  portfolioCaseCount: portfolioCases.length,
  portfolioCases,
  totalVectorCount
}

writeFileSync(join(VECTORS_DIR, 'periodic.json'), JSON.stringify(output, null, 2) + '\n')

console.log(
  `Wrote ${seedBatteryCases.length} seed-battery, ${continuationOrderingCases.length} continuation-ordering, ` +
    `${phaseResidualCases.length} phase-residual, ${catalogCases.length} catalog, and ${portfolioCases.length} ` +
    `portfolio cases (${totalVectorCount} total vectors, commit ${commit}) to ${VECTORS_DIR}`
)
