/**
 * Differential-vector generator for the coordinator port this task adds:
 * `crates/irregular-nesting-native/src/result/{mod,coordinator,materialize,progress}.rs`
 * plus the capacity-mode orchestration it now wires directly --
 * `crates/irregular-nesting-native/src/capacity/mode.rs`'s
 * `run_intrinsic_capacity_mode`/`run_intrinsic_capacity_scheduler_cold_quantum`
 * (ported from `intrinsicCapacityMode.ts`'s `runIntrinsicCapacityMode`/
 * `runProtectedCapacityLaneCoordinator`/`runIntrinsicCapacityCohesionShadow`/
 * `runIntrinsicCapacitySchedulerColdQuantum`).
 *
 * Imports and drives the REAL production entry point --
 *   `computeIrregularNesting` (`src/workers/algorithm/irregular/computeIrregularNesting.ts`)
 * -- through the REAL Effect service layer stack exactly as
 * `nesting.worker.ts`'s `computeIrregularWorkerResult` wires it
 * (`CollisionGeometryBuilder.Live`, `TransformGeneratorLive`,
 * `NfpIfpServiceLive`, `FreeMaterialServiceLive`, `IrregularPlacementScorer.Layer`
 * -- deliberately `.Layer`, not `.Live`, so the placement scorer picks up the
 * request-derived `GeometrySettings` instead of its own default, matching
 * production exactly -- `IrregularLayoutScorer.Live`, `GeometryKernel.Live`,
 * `Layer.succeed(GeometrySettings, geometrySettings)`), driven with
 * `Effect.runSyncExit`.
 *
 * There is no injectable `timingNow`/deterministic-clock seam in
 * `computeIrregularNesting.ts` itself (confirmed by direct source grep --
 * only `intrinsicCapacitySearch.ts`, a lower layer, carries one), so every
 * `performance.now()`-derived field this script's own encoders touch
 * (`preflightRuntimeMs`, `completeArchiveRuntimeMs`, `prefixTerminalizationMs`,
 * `coldSearchMs`, `runtimeMs`, every lane/trace `elapsedMs`, every
 * `IrregularFinalizationMetrics` field, `IrregularPortfolioProgress.elapsedMs`)
 * is deliberately never recorded -- these are the "documented non-semantic
 * timing fields" the task brief excludes. Every other field this script
 * records is real, deterministic algorithm output.
 *
 * Real mixed61 fixture pieces (`tests/fixtures/irregularSheetInvariance/mixed61-request.json`,
 * the same fixture `dump-shared-archive.ts`/`dump-capacity-search.ts` use) are
 * fed through the REAL, unmodified `src/shared/preparePieces.ts#preparePieces`
 * (the genuine production `ImportedPiece[] -> PreparedPiece[]` step run before
 * `computeIrregularNesting` in production) so `sortPiecesForNesting`'s
 * priority order and every downstream geometry step is byte-identical to a
 * real request, not a hand-rolled approximation.
 *
 * Two batteries populate `>= 80` full-job vectors:
 *   - `roomySheetCases`: 2-10 distinct real mixed61 pieces on a generous
 *     sheet, crossed with both production profiles (Compact,
 *     `makeCompactQualityIrregularOptimizerSettings`; Compact Short Side,
 *     `makeCompactShortSideIrregularOptimizerSettings`). These settle
 *     through the shared-archive winner path (no capacity-mode routing).
 *   - `constrainedSheetCases`: the same piece combinations crossed with
 *     tight/tiny sheets designed to force capacity-mode routing (either a
 *     preflight-proven-impossible sheet, or a sheet snug enough that the
 *     complete/sheetless archive search itself has no fitting winner and
 *     the bounded capacity fallback settles the result), again crossed with
 *     both profiles. Each case's *actual* observed routing
 *     (`capacityTrace === null` vs `capacityTrace.routing`) is recorded
 *     verbatim rather than assumed in advance -- exact packing feasibility
 *     for irregular mixed shapes is not something this script predicts, it
 *     is something the real algorithm decides, and both capacity routings
 *     are confirmed present in the generated set before this script writes
 *     its output (see the `preflightProvenImpossible`/`boundedCompleteArchiveMiss`
 *     counts logged at the end).
 *
 * Run with:
 *   pnpm exec tsx --tsconfig tsconfig.node.json scripts/rust-parity/dump-coordinator.ts
 *
 * Output (additive; never edits existing fixtures/tests):
 *   - crates/irregular-nesting-native/tests/vectors/coordinator.json
 */
import { Effect, Layer } from 'effect'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { SheetSpec, NestingOptions, NestingRequest } from '@shared/domain/nesting.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { preparePieces } from '@shared/preparePieces.js'
import {
  IrregularGeometrySettings,
  IrregularNestingSettings
} from '../../src/shared/irregular/domain.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings,
  makeCompactShortSideIrregularOptimizerSettings
} from '../../src/shared/irregular/defaults.js'
import {
  computeIrregularNesting,
  type IrregularComputeResult
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../../src/workers/irregular/freeMaterialService.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'
import { IrregularLayoutScorer } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'

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
function f64BitsOpt(value: number | undefined): string | null {
  return value === undefined ? null : f64Bits(value)
}

// ---------------------------------------------------------------------------
// Mixed61 fixture loading (mirrors `dump-shared-archive.ts`'s own
// `mixed61Fixture`/`fixtureHullRing`, but keeps the *real* line-segment
// geometry -- every source piece in this fixture is confirmed line-segment
// only, no arcs -- instead of pre-reducing to a convex hull ring, since this
// script drives the real `CollisionGeometryBuilder`/`TransformGenerator`
// pipeline `computeIrregularNesting` itself calls, not a lower layer that
// already expects pre-built collision geometry.
// ---------------------------------------------------------------------------
interface FixtureLineSegment {
  readonly kind: string
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}
interface FixturePiece {
  readonly id: string
  readonly sourceFileId: string
  readonly label: string
  readonly realBounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly geometry: { readonly entityType: string; readonly closed: boolean; readonly segments: ReadonlyArray<FixtureLineSegment> }
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
for (const piece of mixed61Fixture.sourcePieces) {
  if (piece.geometry.segments.some((segment) => segment.kind !== 'line')) {
    throw new Error(`fixture piece ${piece.id} has a non-line segment; this script assumes line-only geometry.`)
  }
}

function importedPieceFromFixture(index: number): ImportedPiece {
  const wrapped = ((index % 61) + 61) % 61
  const source = mixed61Fixture.sourcePieces[wrapped]
  if (source === undefined) throw new Error('fixture piece index out of range')
  return new ImportedPiece({
    id: PieceId.make(`${source.id}-slot${index}`),
    sourceFileId: SourceFileId.make(source.sourceFileId),
    label: source.label,
    realBounds: source.realBounds,
    geometry: new DxfGeometrySummary({
      entityType: 'PRESET_SHAPE',
      closed: source.geometry.closed,
      segments: source.geometry.segments.map((segment) => ({
        kind: 'line' as const,
        x1: segment.x1,
        y1: segment.y1,
        x2: segment.x2,
        y2: segment.y2
      }))
    }),
    warnings: []
  })
}

// ---------------------------------------------------------------------------
// Deterministic combo generation (mirrors `dump-shared-archive.ts`'s own
// `COMBOS` construction): distinct real mixed61 slots per combo, spaced by a
// fixed stride so no two slots within one combo ever collide (61 is prime).
// ---------------------------------------------------------------------------
interface Combo {
  readonly label: string
  readonly pieceCount: number
  readonly importedPieces: ImportedPiece[]
}

function buildCombos(minCount: number, maxCount: number, combosPerSize: number): Combo[] {
  const combos: Combo[] = []
  for (let pieceCount = minCount; pieceCount <= maxCount; pieceCount += 1) {
    for (let comboIndex = 0; comboIndex < combosPerSize; comboIndex += 1) {
      const stride = 5 + comboIndex * 3
      const startSlot = comboIndex * 11 + pieceCount * 2
      const slots: number[] = []
      for (let k = 0; k < pieceCount; k += 1) {
        slots.push((startSlot + k * stride) % 61)
      }
      if (new Set(slots).size !== slots.length) {
        throw new Error(`combo n${pieceCount}-c${comboIndex} produced duplicate slots: ${slots.join(',')}`)
      }
      const label = `n${pieceCount}-c${comboIndex}`
      combos.push({
        label,
        pieceCount,
        importedPieces: slots.map((slot, index) => importedPieceFromFixture(slot + index * 61))
      })
    }
  }
  return combos
}

// ---------------------------------------------------------------------------
// Settings profiles: the two production profiles this task targets.
// ---------------------------------------------------------------------------
type ProfileId = 'compact' | 'compact-short-side'
function settingsForProfile(profile: ProfileId): IrregularNestingSettings {
  const optimizer =
    profile === 'compact'
      ? makeCompactQualityIrregularOptimizerSettings()
      : makeCompactShortSideIrregularOptimizerSettings()
  return new IrregularNestingSettings({
    geometry: new IrregularGeometrySettings({ ...DEFAULT_IRREGULAR_GEOMETRY_SETTINGS }),
    optimizer
  })
}

// ---------------------------------------------------------------------------
// Request construction: real `preparePieces` production step, then a real
// `NestingRequest` schema-class instance.
// ---------------------------------------------------------------------------
const BASE_REQUEST_OPTIONS = {
  allowGlobalRotation: true,
  allowGlobalMirror: true,
  timeoutMs: 180_000,
  workerMode: 'irregular-convex-v2' as const,
  historyScope: 'winning_path' as const,
  strategySelectionMode: 'all_configured' as const,
  strategyIds: ['short-fill-bottom-left-then-short-side-fit'],
  layoutSelectionStrategyId: 'compact-first',
  finalSelectionMode: 'manual' as const
}

function buildRequest(
  combo: Combo,
  sheet: SheetSpec,
  profile: ProfileId,
  jobId: string
): NestingRequest {
  const settings = settingsForProfile(profile)
  const { pieces } = preparePieces(
    combo.importedPieces,
    sheet,
    0,
    PieceId.make(jobId) as unknown as never
  )
  return new NestingRequest({
    version: 1,
    jobId: jobId as unknown as never,
    sheet,
    padding: 0,
    pieces,
    sourcePieces: combo.importedPieces,
    options: new NestingOptions({
      ...BASE_REQUEST_OPTIONS,
      historyMode: 'stream',
      irregularSettings: settings
    })
  })
}

function sheetSpec(width: number, height: number, label: string): SheetSpec {
  return new SheetSpec({ width, height, label })
}

// ---------------------------------------------------------------------------
// Effect layer runner -- exactly `nesting.worker.ts`'s
// `computeIrregularWorkerResult` layer stack.
// ---------------------------------------------------------------------------
function runCompute(
  request: NestingRequest,
  settings: IrregularNestingSettings
): ReturnType<typeof Effect.runSyncExit<IrregularComputeResult, unknown>> {
  return Effect.runSyncExit(
    computeIrregularNesting(request).pipe(
      Effect.provide(CollisionGeometryBuilder.Live),
      Effect.provide(TransformGeneratorLive),
      Effect.provide(NfpIfpServiceLive),
      Effect.provide(FreeMaterialServiceLive),
      Effect.provide(IrregularPlacementScorer.Layer),
      Effect.provide(IrregularLayoutScorer.Live),
      Effect.provide(GeometryKernel.Live),
      Effect.provide(Layer.succeed(GeometrySettings, settings))
    )
  ) as ReturnType<typeof Effect.runSyncExit<IrregularComputeResult, unknown>>
}

type ComputedResult = IrregularComputeResult

// ---------------------------------------------------------------------------
// Encoding: mirrors this task's Rust-side `tests/coordinator_vectors.rs`
// encoders field-for-field. Every f64 is `f64Bits`; every documented
// non-semantic timing field (`*RuntimeMs`, `*Ms`, `elapsedMs`) is omitted.
// ---------------------------------------------------------------------------
function encodeTransform(transform: { readonly translateX: number; readonly translateY: number; readonly rotationDeg: number; readonly mirrored: boolean }) {
  return {
    translateX: f64Bits(transform.translateX),
    translateY: f64Bits(transform.translateY),
    rotationDeg: f64Bits(transform.rotationDeg),
    mirrored: transform.mirrored
  }
}
function encodePlacement(placement: { readonly pieceId?: unknown; readonly sourcePieceId: unknown; readonly transform: Parameters<typeof encodeTransform>[0] }) {
  return {
    pieceId: placement.pieceId === undefined ? null : String(placement.pieceId),
    sourcePieceId: String(placement.sourcePieceId),
    transform: encodeTransform(placement.transform)
  }
}
function encodeScore(score: Record<string, unknown> | undefined) {
  if (score === undefined) return null
  const optionalKeys = [
    'sharedCollisionBoundaryLengthMm',
    'sharedCollisionBoundaryContactUnits',
    'sharedCollisionBoundaryContactBand',
    'nearCompleteStructuralContactCount',
    'dominantNearCompleteStructuralContactCount',
    'canonicalEnclosedCavityCount'
  ] as const
  const encoded: Record<string, unknown> = {
    unplacedCount: f64Bits(score.unplacedCount as number),
    largestNetFreeMaterialRegionAreaMm2: f64Bits(score.largestNetFreeMaterialRegionAreaMm2 as number),
    freeMaterialRegionCount: f64Bits(score.freeMaterialRegionCount as number),
    freeMaterialHoleCount: f64Bits(score.freeMaterialHoleCount as number),
    freeMaterialSliverMetric: f64Bits(score.freeMaterialSliverMetric as number),
    collisionBoundsWorstNormalizedSheetConsumption: f64Bits(
      score.collisionBoundsWorstNormalizedSheetConsumption as number
    ),
    collisionBoundsNormalizedSpanSum: f64Bits(score.collisionBoundsNormalizedSpanSum as number),
    collisionBoundsAreaMm2: f64Bits(score.collisionBoundsAreaMm2 as number),
    collisionBoundsSpanMm: f64Bits(score.collisionBoundsSpanMm as number)
  }
  for (const key of optionalKeys) {
    encoded[key] = f64BitsOpt(score[key] as number | undefined)
  }
  return encoded
}
function encodePortfolio(portfolio: ComputedResult['portfolio']) {
  return {
    status: portfolio.status,
    terminationReason: portfolio.terminationReason ?? null,
    source: portfolio.source,
    placements: portfolio.placements.map(encodePlacement),
    unplacedPieceIds: portfolio.unplacedPieceIds.map(String),
    score: encodeScore(portfolio.score as unknown as unknown as Record<string, unknown> | undefined)
  }
}
function encodeSnapshot(snapshot: ComputedResult['stateSnapshots'][number]) {
  return {
    stepIndex: f64Bits(snapshot.stepIndex),
    beamRank: f64Bits(snapshot.beamRank),
    candidateCount: f64Bits(snapshot.candidateCount),
    source: snapshot.source ?? null,
    placedPieceCount: f64Bits(snapshot.state.placedCollisionGeometries.length)
  }
}
function encodeCapacityObjective(objective: Record<string, unknown> | undefined) {
  if (objective === undefined) return null
  return {
    placedCount: f64Bits(objective.placedCount as number),
    placedDoubledMaterialAreaGrid2: String(objective.placedDoubledMaterialAreaGrid2),
    enclosedCavityCount: f64Bits(objective.enclosedCavityCount as number),
    totalEnclosedCavityAreaMm2: f64Bits(objective.totalEnclosedCavityAreaMm2 as number),
    totalEnclosedCavityDoubledAreaGrid2: String(objective.totalEnclosedCavityDoubledAreaGrid2),
    envelopeMaximumSideMm: f64Bits(objective.envelopeMaximumSideMm as number),
    envelopeAreaMm2: f64Bits(objective.envelopeAreaMm2 as number),
    envelopeSpanMm: f64Bits(objective.envelopeSpanMm as number),
    envelopeMaximumSideGrid: f64Bits(objective.envelopeMaximumSideGrid as number),
    envelopeAreaGrid2: String(objective.envelopeAreaGrid2),
    envelopeSpanGrid: f64Bits(objective.envelopeSpanGrid as number),
    canonicalGeometryHash: String(objective.canonicalGeometryHash),
    origin: String(objective.origin),
    prefixDepth: f64BitsOpt(objective.prefixDepth as number | undefined),
    sourceRole: objective.sourceRole === undefined ? null : String(objective.sourceRole)
  }
}
function encodeWarmPrefixLane(lane: Record<string, unknown>) {
  return {
    sourceRole: String(lane.sourceRole),
    prefixDepth: f64Bits(lane.prefixDepth as number),
    reusedPlacedCount: f64Bits(lane.reusedPlacedCount as number),
    status: String(lane.status),
    selectedForContinuation: lane.selectedForContinuation,
    checkpointRetained: lane.checkpointRetained,
    consumedPlacementEvaluations: f64Bits(lane.consumedPlacementEvaluations as number),
    completedDepths: f64Bits(lane.completedDepths as number),
    endpoint: encodeCapacityObjective(lane.endpoint as unknown as Record<string, unknown> | undefined)
  }
}
function encodeQualityWarmPrefix(trace: Record<string, unknown> | undefined) {
  if (trace === undefined) return null
  return {
    status: String(trace.status),
    outputInfluence: String(trace.outputInfluence),
    sourceRole: trace.sourceRole === undefined ? null : String(trace.sourceRole),
    prefixDepth: f64BitsOpt(trace.prefixDepth as number | undefined),
    reusedPlacedCount: f64Bits(trace.reusedPlacedCount as number),
    requestPieceCount: f64Bits(trace.requestPieceCount as number),
    minimumPieceCount: f64Bits(trace.minimumPieceCount as number),
    placementEvaluationCap: f64Bits(trace.placementEvaluationCap as number),
    consumedPlacementEvaluations: f64Bits(trace.consumedPlacementEvaluations as number),
    completedDepths: f64Bits(trace.completedDepths as number),
    checkpointRetained: trace.checkpointRetained,
    endpoint: encodeCapacityObjective(trace.endpoint as unknown as Record<string, unknown> | undefined)
  }
}
function encodeLaneCoordinatorQuantum(quantum: Record<string, unknown>) {
  return {
    ordinal: f64Bits(quantum.ordinal as number),
    producerRole: String(quantum.producerRole),
    sourceRole: quantum.sourceRole === undefined ? null : String(quantum.sourceRole),
    prefixDepth: f64BitsOpt(quantum.prefixDepth as number | undefined),
    phase: String(quantum.phase),
    fromDepth: f64Bits(quantum.fromDepth as number),
    toDepth: f64Bits(quantum.toDepth as number),
    placementEvaluationDelta: f64Bits(quantum.placementEvaluationDelta as number),
    outcome: String(quantum.outcome)
  }
}
function encodeLaneCoordinator(trace: Record<string, unknown> | undefined) {
  if (trace === undefined) return null
  return {
    aggregatePlacementEvaluationCap: f64Bits(trace.aggregatePlacementEvaluationCap as number),
    aggregateConsumedPlacementEvaluations: f64Bits(trace.aggregateConsumedPlacementEvaluations as number),
    warmPilotDepthBoundaries: f64Bits(trace.warmPilotDepthBoundaries as number),
    retainedCheckpointCount: f64Bits(trace.retainedCheckpointCount as number),
    censoredLaneCount: f64Bits(trace.censoredLaneCount as number),
    quanta: (trace.quanta as ReadonlyArray<Record<string, unknown>>).map(encodeLaneCoordinatorQuantum)
  }
}
function encodeCapacityTrace(trace: ComputedResult['capacityTrace']) {
  if (trace === undefined) return null
  const preflight = trace.preflight as unknown as Record<string, unknown>
  const selected = trace.selected as unknown as Record<string, unknown>
  const prefixIncumbent = trace.prefixIncumbent as unknown as Record<string, unknown> | undefined
  const coldSearch = trace.coldSearch as unknown as Record<string, unknown>
  return {
    routing: trace.routing,
    preflightKind: String(preflight.kind),
    preflightReason: preflight.reason === undefined ? null : String(preflight.reason),
    prefixes: {
      capturedCount: f64Bits((trace.prefixes as unknown as Record<string, unknown>).capturedCount as number),
      fittingCount: f64Bits((trace.prefixes as unknown as Record<string, unknown>).fittingCount as number),
      rejectedCount: f64Bits((trace.prefixes as unknown as Record<string, unknown>).rejectedCount as number),
      terminalizedCount: f64Bits((trace.prefixes as unknown as Record<string, unknown>).terminalizedCount as number)
    },
    prefixIncumbent:
      prefixIncumbent === undefined
        ? null
        : {
            sourceRole: prefixIncumbent.sourceRole === undefined ? null : String(prefixIncumbent.sourceRole),
            prefixDepth: f64BitsOpt(prefixIncumbent.prefixDepth as number | undefined),
            placedCount: f64Bits(prefixIncumbent.placedCount as number),
            placedMaterialAreaMm2: f64Bits(prefixIncumbent.placedMaterialAreaMm2 as number),
            selectedRotationDeg: f64Bits(prefixIncumbent.selectedRotationDeg as number),
            canonicalGeometryHash: String(prefixIncumbent.canonicalGeometryHash)
          },
    coldSearch: {
      settlement: String(coldSearch.settlement),
      consumedPlacementEvaluations: f64Bits(coldSearch.consumedPlacementEvaluations as number),
      placementEvaluationCap: f64Bits(coldSearch.placementEvaluationCap as number),
      prunedByAttainableCount: f64Bits(coldSearch.prunedByAttainableCount as number),
      prunedByAttainableMaterial: f64Bits(coldSearch.prunedByAttainableMaterial as number),
      completedDepths: f64Bits(coldSearch.completedDepths as number),
      pieceCount: f64Bits(coldSearch.pieceCount as number)
    },
    warmPrefixLanes:
      trace.warmPrefixLanes === undefined
        ? null
        : (trace.warmPrefixLanes as unknown as ReadonlyArray<Record<string, unknown>>).map(encodeWarmPrefixLane),
    warmPrefixEndpointsAdmitted: trace.warmPrefixEndpointsAdmitted,
    cohesionShadow: trace.cohesionShadow === undefined ? null : 'present',
    qualityWarmPrefix: encodeQualityWarmPrefix(trace.qualityWarmPrefix as unknown as Record<string, unknown> | undefined),
    laneCoordinator: encodeLaneCoordinator(trace.laneCoordinator as unknown as Record<string, unknown> | undefined),
    selected: {
      objective: encodeCapacityObjective(selected),
      unplacedCount: f64Bits(selected.unplacedCount as number),
      placedMaterialAreaMm2: f64Bits(selected.placedMaterialAreaMm2 as number),
      selectedRotationDeg: f64Bits(selected.selectedRotationDeg as number)
    }
  }
}
function encodeSchedulerQuantum(quantum: Record<string, unknown>) {
  return {
    ordinal: f64Bits(quantum.ordinal as number),
    cohort: String(quantum.cohort),
    producerRole: String(quantum.producerRole),
    outcome: String(quantum.outcome)
  }
}
function encodeSchedulerTrace(trace: ComputedResult['intrinsicAnytimeSchedulerTrace']) {
  if (trace === undefined) return null
  return {
    coldQuantumDepths: f64Bits(trace.coldQuantumDepths),
    coldStartStatus: trace.coldStartStatus,
    coldStartCompletedDepths: f64Bits(trace.coldStartCompletedDepths),
    coldStartConsumedPlacementEvaluations: f64Bits(trace.coldStartConsumedPlacementEvaluations),
    coldCheckpointReused: trace.coldCheckpointReused,
    warmPrefixEndpointsAdmitted: trace.warmPrefixEndpointsAdmitted,
    cancellationReason: trace.cancellationReason ?? null,
    quanta: trace.quanta.map((quantum) => encodeSchedulerQuantum(quantum as unknown as unknown as Record<string, unknown>))
  }
}
function encodeFocusedReconstruction(trace: ComputedResult['focusedCompleteReconstructionTrace']) {
  if (trace === undefined) return null
  return {
    status: trace.status,
    sourceCanonicalGeometryHash: trace.sourceCanonicalGeometryHash ?? null,
    candidateCanonicalGeometryHash: trace.candidateCanonicalGeometryHash ?? null,
    selectedCanonicalGeometryHash: trace.selectedCanonicalGeometryHash ?? null,
    consumedCandidateEvaluations: f64Bits(trace.consumedCandidateEvaluations),
    candidateEvaluationAccountingComplete: trace.candidateEvaluationAccountingComplete,
    outputInfluence: trace.outputInfluence,
    failureReason: trace.failureReason ?? null
  }
}
function encodeShortSideObserver(trace: ComputedResult['intrinsicShortSideObserverTrace']) {
  if (trace === undefined) return null
  const record = trace as unknown as unknown as Record<string, unknown>
  return {
    status: String(record.status),
    outputInfluence: String(record.outputInfluence),
    settledEndpointCount: f64Bits(record.settledEndpointCount as number),
    evaluatedOrientationCount: f64Bits(record.evaluatedOrientationCount as number),
    observerWinnerCanonicalGeometryHash:
      record.observerWinnerCanonicalGeometryHash === undefined
        ? null
        : String(record.observerWinnerCanonicalGeometryHash)
  }
}
function encodeShortSidePairFold(trace: ComputedResult['intrinsicShortSidePairFoldTrace']) {
  if (trace === undefined) return null
  const record = trace as unknown as unknown as Record<string, unknown>
  return {
    status: String(record.status),
    constructionKind: record.constructionKind === undefined ? null : String(record.constructionKind),
    canonicalGeometryHash: record.canonicalGeometryHash === undefined ? null : String(record.canonicalGeometryHash),
    outputInfluence: record.outputInfluence === undefined ? null : String(record.outputInfluence)
  }
}
function encodeResult(result: ComputedResult) {
  return {
    placedCollisionGeometryCount: f64Bits(result.placedCollisionGeometries.length),
    placements: result.placedCollisionGeometries.map((placed) => encodePlacement(placed.placement)),
    unplacedPieceIds: result.unplacedPieceIds.map(String),
    sortedPieceIds: result.sortedPieceIds.map(String),
    beamWidth: f64Bits(result.beamWidth),
    score: encodeScore(result.score as unknown as unknown as Record<string, unknown>),
    portfolio: encodePortfolio(result.portfolio),
    snapshotCount: f64Bits(result.stateSnapshots.length),
    snapshots: result.stateSnapshots.map(encodeSnapshot),
    capacityTrace: encodeCapacityTrace(result.capacityTrace),
    intrinsicAnytimeSchedulerTrace: encodeSchedulerTrace(result.intrinsicAnytimeSchedulerTrace),
    focusedCompleteReconstructionTrace: encodeFocusedReconstruction(result.focusedCompleteReconstructionTrace),
    intrinsicShortSideObserverTrace: encodeShortSideObserver(result.intrinsicShortSideObserverTrace),
    intrinsicShortSidePairFoldTrace: encodeShortSidePairFold(result.intrinsicShortSidePairFoldTrace)
  }
}

// ---------------------------------------------------------------------------
// Request encoding: enough for the Rust harness to independently reconstruct
// an equivalent `NestingRequest`/`IrregularNestingSettings` (real segment
// geometry, real settings fields the Rust port actually reads).
// ---------------------------------------------------------------------------
// Matches the real Rust `domain::source::ImportedPiece`'s own `Deserialize`
// shape exactly (camelCase, internally-tagged `DxfGeometrySegment`), so the
// Rust harness can `serde_json::from_value::<ImportedPiece>` this directly
// instead of hand-reconstructing it field by field.
function encodeImportedPiece(piece: ImportedPiece) {
  return {
    id: String(piece.id),
    sourceFileId: String(piece.sourceFileId),
    label: piece.label,
    realBounds: { ...piece.realBounds },
    geometry: {
      entityType: 'PRESET_SHAPE',
      closed: piece.geometry.closed,
      segments: piece.geometry.segments.map((segment) => {
        const line = segment as { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
        return { kind: 'line', x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2 }
      })
    },
    warnings: []
  }
}
function encodePreparedPiece(piece: NestingRequest['pieces'][number]) {
  return {
    id: String(piece.id),
    sourcePieceId: String(piece.sourcePieceId),
    interchangeabilityKey: piece.interchangeabilityKey ?? null,
    realBounds: { ...piece.realBounds },
    paddedBounds: { ...piece.paddedBounds },
    padding: piece.padding,
    allowRotation: piece.allowRotation,
    allowMirror: piece.allowMirror
  }
}
function encodeOptimizerSettings(optimizer: IrregularNestingSettings['optimizer']) {
  return {
    orderWindow: optimizer.orderWindow,
    beamWidth: optimizer.beamWidth,
    localCandidateFanout: optimizer.localCandidateFanout,
    localRepairBudget: optimizer.localRepairBudget,
    intrinsicSharedArchiveEnabled: optimizer.intrinsicSharedArchiveEnabled,
    intrinsicObjectiveProfileId: optimizer.intrinsicObjectiveProfileId,
    transformCap: optimizer.transformCap,
    transformMinimumEdgeLengthMm: optimizer.transformMinimumEdgeLengthMm,
    transformAngleDeduplicationToleranceDeg: optimizer.transformAngleDeduplicationToleranceDeg,
    configuredRotationEnabled: optimizer.configuredRotationEnabled,
    edgeAlignmentEnabled: optimizer.edgeAlignmentEnabled,
    configuredRotationDeg: [...optimizer.configuredRotationDeg],
    gaEnabled: optimizer.gaEnabled,
    baselineOnly: optimizer.baselineOnly,
    gaPopulation: optimizer.gaPopulation,
    gaGenerationBudget: optimizer.gaGenerationBudget,
    gaEvaluationBudget: optimizer.gaEvaluationBudget,
    gaTimeBudgetMs: optimizer.gaTimeBudgetMs,
    gaSeed: optimizer.gaSeed,
    priorityOrderMutationEnabled: optimizer.priorityOrderMutationEnabled,
    transformPreferenceMutationEnabled: optimizer.transformPreferenceMutationEnabled,
    placementPolicyMutationEnabled: optimizer.placementPolicyMutationEnabled,
    placementPolicyId: optimizer.placementPolicyId,
    placementPolicyIds: [...(optimizer.placementPolicyIds ?? [])]
  }
}
function encodeRequest(request: NestingRequest, settings: IrregularNestingSettings) {
  return {
    sheet: { width: request.sheet.width, height: request.sheet.height, label: request.sheet.label },
    padding: request.padding,
    pieces: request.pieces.map(encodePreparedPiece),
    sourcePieces: (request.sourcePieces ?? []).map(encodeImportedPiece),
    allowGlobalRotation: request.options.allowGlobalRotation,
    allowGlobalMirror: request.options.allowGlobalMirror,
    historyMode: request.options.historyMode,
    settings: {
      geometry: {
        flatteningSagToleranceMm: settings.geometry.flatteningSagToleranceMm,
        clearanceSafetyMarginMm: settings.geometry.clearanceSafetyMarginMm,
        geometryBackendId: settings.geometry.geometryBackendId,
        geometryBackendVersion: settings.geometry.geometryBackendVersion
      },
      optimizer: encodeOptimizerSettings(settings.optimizer)
    }
  }
}

// ===========================================================================
// Case generation.
// ===========================================================================
interface CaseRecord {
  readonly caseId: string
  readonly kind: 'roomy' | 'constrained'
  readonly profile: ProfileId
  readonly request: ReturnType<typeof encodeRequest>
  readonly result: ReturnType<typeof encodeResult>
}

const cases: CaseRecord[] = []
const skippedCaseIds: string[] = []
let jobCounter = 0

/**
 * A minority of constrained-sheet / Short Side combinations are genuine TS
 * production failures, not dump-script bugs: e.g. a preflight-proven-
 * impossible sheet under the Short Side profile leaves
 * `settledCompleteArchiveForShortSideObserver` empty (`capacity-core.md`
 * §1's own documented consequence), which can make the directional Short
 * Side construction invariant itself unsatisfiable
 * (`IrregularNoValidResultError`, operation `intrinsicShortSide`). Recording
 * *that* exact error as a "successful" full-job vector is out of this
 * script's scope (the task brief asks for full-job results, not an
 * error-taxonomy differential suite -- error-path parity is already
 * separately covered by `tests/coordinator_vectors.rs`'s existing
 * `missing_source_geometry_returns_the_typed_compute_error`/
 * `archive_ineligible_settings_return_a_typed_routing_error` cases), so
 * this generator skips (never silently substitutes a fake result for) any
 * case the real algorithm itself cannot complete, and over-generates
 * combos so the final count still clears the >= 80 floor.
 */
function runCase(kind: 'roomy' | 'constrained', combo: Combo, sheet: SheetSpec, profile: ProfileId): void {
  jobCounter += 1
  const jobId = `dump-coordinator-job-${jobCounter}`
  const caseId = `${kind}-${combo.label}-${sheet.label}-${profile}`
  const settings = settingsForProfile(profile)
  const request = buildRequest(combo, sheet, profile, jobId)
  const exit = runCompute(request, settings)
  if (exit._tag !== 'Success' || exit.value === undefined) {
    skippedCaseIds.push(caseId)
    console.warn(`skipping case ${caseId}: ${JSON.stringify(exit).slice(0, 400)}`)
    return
  }
  cases.push({
    caseId,
    kind,
    profile,
    request: encodeRequest(request, settings),
    result: encodeResult(exit.value)
  })
}

const PROFILES: ReadonlyArray<ProfileId> = ['compact', 'compact-short-side']

// Battery 1: roomy sheets, 2-10 pieces, both profiles.
const roomyCombos = buildCombos(2, 10, 2)
for (const combo of roomyCombos) {
  const sheet = sheetSpec(2000, 2000, `roomy-${combo.label}`)
  for (const profile of PROFILES) {
    runCase('roomy', combo, sheet, profile)
  }
}

// Battery 2: constrained sheets, both profiles -- forcing capacity routing.
// `tiny`: sheet far smaller than any combo's minimum collision area (should
// prove impossible). `tight`: sheet sized close to the combo's own bounding
// footprint (should either prove impossible or bounded-miss into capacity
// mode, exercising the warm-prefix/quality-warm-prefix lanes once several
// pieces are involved).
const constrainedCombos = buildCombos(2, 8, 3)
for (const combo of constrainedCombos) {
  const tinySheet = sheetSpec(40, 40, `tiny-${combo.label}`)
  const tightSheet = sheetSpec(140, 110, `tight-${combo.label}`)
  for (const profile of PROFILES) {
    runCase('constrained', combo, tinySheet, profile)
    runCase('constrained', combo, tightSheet, profile)
  }
}

// ===========================================================================
// Vector-count accounting, routing-diversity check, and write-out.
// ===========================================================================
if (cases.length < 80) {
  throw new Error(`Expected >= 80 coordinator vectors, got ${cases.length}.`)
}

const routingCounts = { none: 0, 'preflight-proven-impossible': 0, 'bounded-complete-archive-miss': 0 }
for (const c of cases) {
  const routing = c.result.capacityTrace === null ? 'none' : (c.result.capacityTrace as { routing: string }).routing
  routingCounts[routing as keyof typeof routingCounts] += 1
}
if (routingCounts['preflight-proven-impossible'] === 0) {
  throw new Error('Expected at least one preflight-proven-impossible case; none observed.')
}
if (routingCounts['bounded-complete-archive-miss'] === 0) {
  throw new Error('Expected at least one bounded-complete-archive-miss case; none observed.')
}

mkdirSync(VECTORS_DIR, { recursive: true })
const commit = generatingCommit()

const output = {
  generatedByScript: 'scripts/rust-parity/dump-coordinator.ts',
  generatingCommit: commit,
  description:
    'computeIrregularNesting.ts full-job coverage via the real Effect-layered production entry point ' +
    '(CollisionGeometryBuilder.Live, TransformGeneratorLive, NfpIfpServiceLive, FreeMaterialServiceLive, ' +
    'IrregularPlacementScorer.Layer, IrregularLayoutScorer.Live, GeometryKernel.Live, request-derived ' +
    'GeometrySettings -- exactly nesting.worker.ts\'s own layer stack): roomy-sheet shared-archive-winner ' +
    'cases and constrained/tiny-sheet capacity-routed cases (both preflight-proven-impossible and ' +
    'bounded-complete-archive-miss, confirmed present), crossed with both the Compact and Compact Short ' +
    'Side production profiles. Real mixed61 fixture piece geometry through the real preparePieces() ' +
    'production step. f64 values are recorded as big-endian IEEE-754 bit-pattern hex strings for bit-exact ' +
    'comparison. Every performance.now()-derived field (there is no timingNow seam in computeIrregularNesting.ts ' +
    'itself) is deliberately omitted as documented non-semantic timing data.',
  routingCounts,
  caseCount: cases.length,
  cases
}

writeFileSync(join(VECTORS_DIR, 'coordinator.json'), JSON.stringify(output, null, 2) + '\n')

const fileBytes = readFileSync(join(VECTORS_DIR, 'coordinator.json'))
const fileHash = createHash('sha256').update(fileBytes).digest('hex')

console.log(
  `Wrote ${cases.length} coordinator cases (routing: none=${routingCounts.none}, ` +
    `preflight-proven-impossible=${routingCounts['preflight-proven-impossible']}, ` +
    `bounded-complete-archive-miss=${routingCounts['bounded-complete-archive-miss']}, ` +
    `commit ${commit}, file sha256 ${fileHash}) to ${VECTORS_DIR}`
)
