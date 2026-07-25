import type { AlgorithmBenchmark, NestingRequest, NestingResult } from '@shared/domain/nesting.js'
import {
  NestingRunSummary,
  NestingResult as NestingResultModel,
  NestingStrategyResult,
  NestingSubRun
} from '@shared/domain/nesting.js'
import {
  IrregularHistoryFrame,
  IrregularLayout,
  IrregularLayoutScoreSummary
} from '@shared/irregular/domain.js'
import { IrregularPoint, IrregularPolygon } from '@shared/irregular/domain.js'
import type { IrregularComputeResult, IrregularStateSnapshot } from './computeIrregularNesting.js'

const IRREGULAR_BEAM_STRATEGY_ID = 'irregular-convex-windowed-beam'
const IRREGULAR_SHARED_ARCHIVE_STRATEGY_ID = 'irregular-convex-shared-archive'
const IRREGULAR_SHORT_SIDE_STRATEGY_ID = 'irregular-convex-compact-short-side'
const IRREGULAR_BEAM_STRATEGY_LABEL = 'Irregular convex windowed beam'
const IRREGULAR_SHARED_ARCHIVE_STRATEGY_LABEL = 'Irregular convex shared archive'
const IRREGULAR_SHORT_SIDE_STRATEGY_LABEL = 'Irregular convex Compact Short Side'

/** Real protocol-facing output derived from one completed irregular portfolio run. */
export interface IrregularWorkerOutput {
  readonly result: NestingResult
  readonly historyFrames: ReadonlyArray<IrregularHistoryFrame>
}

/** Stable worker-run identifier shared by result output and every history frame. */
export function irregularStrategyRunId(
  request: NestingRequest,
  source: 'beam' | 'shared-archive' = 'beam'
): string {
  const strategyId =
    source === 'shared-archive'
      ? sharedArchiveStrategyId(request)
      : IRREGULAR_BEAM_STRATEGY_ID
  return request.strategyRunId ?? `${request.jobId}-${strategyId}`
}

/** Maps one beam-selected state into its tagged transform-based history record. */
export function makeIrregularHistoryFrame(input: {
  readonly request: NestingRequest
  readonly strategyRunId: string
  readonly snapshot: IrregularStateSnapshot
  readonly beamWidth: number
  readonly createdAt: string
}): IrregularHistoryFrame {
  const { snapshot } = input
  const sharedArchive = snapshot.source === 'shared-archive'
  const strategyLabel =
    sharedArchive && shortSideProfileRequested(input.request)
      ? IRREGULAR_SHORT_SIDE_STRATEGY_LABEL
      : sharedArchive
        ? IRREGULAR_SHARED_ARCHIVE_STRATEGY_LABEL
        : IRREGULAR_BEAM_STRATEGY_LABEL
  return new IrregularHistoryFrame({
    kind: 'irregular',
    frameId: `${input.strategyRunId}:${snapshot.stepIndex}:${snapshot.beamRank}`,
    jobId: input.request.jobId,
    strategyRunId: input.strategyRunId,
    strategyLabel,
    stepIndex: snapshot.stepIndex,
    title: sharedArchive
      ? snapshot.state.remainingPreparedPieces.length === 0
        ? 'shared-archive-final-selected'
        : 'shared-archive-selected-layout-reveal'
      : snapshot.stepIndex === 0
        ? 'initial-beam'
        : 'beam-state-selected',
    placements: snapshot.state.placedCollisionGeometries.map(({ placement }) => placement),
    collisionPolygons: translatedCollisionPolygons(snapshot.state.placedCollisionGeometries),
    remainingPieceIds: snapshot.state.remainingPreparedPieces.map(
      (piece) => piece.pieceId ?? piece.source.id
    ),
    unplacedPieceIds: snapshot.state.unplacedPieceIds,
    beamRank: snapshot.beamRank,
    beamWidth: sharedArchive ? 1 : input.beamWidth,
    candidateCount: snapshot.candidateCount,
    createdAt: input.createdAt
  })
}

/**
 * Translates the algorithm-owned convex beam output into shared result and
 * history schemas without converting transform placements into rectangles.
 */
export function makeIrregularWorkerOutput(input: {
  readonly request: NestingRequest
  readonly computed: IrregularComputeResult
  readonly algorithmBenchmark: AlgorithmBenchmark
}): IrregularWorkerOutput {
  const portfolio = input.computed.portfolio
  const strategyRunId = irregularStrategyRunId(
    input.request,
    portfolio.source === 'shared-archive' ? 'shared-archive' : 'beam'
  )
  const strategyId =
    portfolio.source === 'shared-archive'
      ? sharedArchiveStrategyId(input.request)
      : IRREGULAR_BEAM_STRATEGY_ID
  const strategyLabel =
    portfolio.source === 'shared-archive'
      ? shortSideProfileRequested(input.request)
        ? IRREGULAR_SHORT_SIDE_STRATEGY_LABEL
        : IRREGULAR_SHARED_ARCHIVE_STRATEGY_LABEL
      : IRREGULAR_BEAM_STRATEGY_LABEL
  const collisionPolygons = translatedCollisionPolygons(input.computed.placedCollisionGeometries)
  const layout = new IrregularLayout({
    kind: 'irregular',
    placements: input.computed.placedCollisionGeometries.map(({ placement }) => placement),
    collisionPolygons,
    unplacedPieceIds: input.computed.unplacedPieceIds,
    score: scoreSummary(
      input.computed,
      input.computed.portfolio.score?.canonicalEnclosedCavityCount
    ),
    source: portfolio.source,
    status: portfolio.status,
    diagnostics: [...input.computed.diagnostics, ...portfolio.diagnostics]
  })
  const historyFrames = input.computed.stateSnapshots.map((snapshot) =>
    makeIrregularHistoryFrame({
      request: input.request,
      strategyRunId,
      snapshot,
      beamWidth: input.computed.beamWidth,
      createdAt: input.algorithmBenchmark.endedAt
    })
  )
  const strategyResult = NestingStrategyResult.fromAlgorithm({
    strategyRunId,
    strategyId,
    strategyLabel,
    strategyDescription:
      portfolio.source === 'shared-archive'
        ? shortSideProfileRequested(input.request)
          ? 'Protected Compact construction followed by one bounded, exact, single-worker Short Side terminal selector with an explicit Compact fallback.'
          : 'Deterministic sheet-independent direct and periodic constructors selected through one exact topology archive.'
        : 'Deterministic convex NFP/IFP search with a configurable windowed beam and seeded portfolio search.',
    sortedPieceIds: input.computed.sortedPieceIds,
    placements: [],
    unplacedPieceIds: input.computed.unplacedPieceIds,
    layout,
    elapsedMs: input.algorithmBenchmark.elapsedMs,
    pieceCount: input.request.pieces.length,
    algorithmBenchmark: input.algorithmBenchmark
  })
  const subRun = new NestingSubRun({
    subRunId: strategyRunId,
    parentRunId: input.request.strategyRunId ?? input.request.jobId,
    index: 0,
    sheet: input.request.sheet,
    padding: input.request.padding,
    options: input.request.options,
    placements: [],
    unplacedPieceIds: input.computed.unplacedPieceIds,
    layout,
    pieceIds: input.request.pieces.map((piece) => piece.id),
    requestPieceIds: input.request.pieces.map((piece) => piece.id)
  })
  const runSummary = new NestingRunSummary({
    runId: strategyRunId,
    subRuns: [subRun],
    totalPlaced: layout.placements.length,
    totalUnplaced: layout.unplacedPieceIds.length,
    totalSheetAreaMm2: input.request.sheet.width * input.request.sheet.height,
    usedAreaMm2: layout.score.collisionBoundsAreaMm2
  })

  return {
    result: NestingResultModel.fromAlgorithm({
      request: input.request,
      strategyResults: [strategyResult],
      selectedStrategyRunId: strategyRunId,
      sortedPieceIds: input.computed.sortedPieceIds,
      placements: [],
      unplacedPieceIds: input.computed.unplacedPieceIds,
      layout,
      elapsedMs: input.algorithmBenchmark.elapsedMs,
      algorithmBenchmark: input.algorithmBenchmark,
      runSummary,
      preparedPieces: input.request.pieces
    }),
    historyFrames
  }
}

function shortSideProfileRequested(request: NestingRequest): boolean {
  return request.options.irregularSettings?.optimizer.intrinsicObjectiveProfileId === 'short-side'
}

function sharedArchiveStrategyId(request: NestingRequest): string {
  return shortSideProfileRequested(request)
    ? IRREGULAR_SHORT_SIDE_STRATEGY_ID
    : IRREGULAR_SHARED_ARCHIVE_STRATEGY_ID
}

function translatedCollisionPolygons(
  placedCollisionGeometries: IrregularComputeResult['placedCollisionGeometries']
): ReadonlyArray<IrregularPolygon> {
  return placedCollisionGeometries.map(({ placement, collisionGeometry }) => {
    const { translateX, translateY } = placement.transform
    return new IrregularPolygon({
      points: collisionGeometry.polygon.points.map(
        (point) => new IrregularPoint({ x: point.x + translateX, y: point.y + translateY })
      )
    })
  })
}

function scoreSummary(
  computed: IrregularComputeResult,
  canonicalEnclosedCavityCount: number | undefined
): IrregularLayoutScoreSummary {
  const score = computed.score
  return new IrregularLayoutScoreSummary({
    unplacedCount: score.unplacedCount,
    sharedCollisionBoundaryLengthMm: score.sharedCollisionBoundaryLengthMm,
    sharedCollisionBoundaryContactUnits: score.sharedCollisionBoundaryContactUnits,
    sharedCollisionBoundaryContactBand: score.sharedCollisionBoundaryContactBand,
    nearCompleteStructuralContactCount: score.nearCompleteStructuralContactCount,
    dominantNearCompleteStructuralContactCount:
      score.dominantNearCompleteStructuralContactCount,
    largestNetFreeMaterialRegionAreaMm2: score.largestNetFreeMaterialRegionAreaMm2,
    freeMaterialRegionCount: score.freeMaterialRegionCount,
    freeMaterialHoleCount: score.freeMaterialHoleCount,
    ...(canonicalEnclosedCavityCount === undefined ? {} : { canonicalEnclosedCavityCount }),
    freeMaterialSliverMetric: score.freeMaterialSliverMetric,
    collisionBoundsWorstNormalizedSheetConsumption:
      score.collisionBoundsWorstNormalizedSheetConsumption,
    collisionBoundsNormalizedSpanSum: score.collisionBoundsNormalizedSpanSum,
    collisionBoundsAreaMm2: score.collisionBoundsAreaMm2,
    collisionBoundsSpanMm: score.collisionBoundsSpanMm
  })
}
