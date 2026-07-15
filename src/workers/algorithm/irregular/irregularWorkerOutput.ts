import type {
  AlgorithmBenchmark,
  NestingRequest,
  NestingResult
} from '@shared/domain/nesting.js'
import {
  NestingResult as NestingResultModel,
  NestingStrategyResult
} from '@shared/domain/nesting.js'
import {
  IrregularHistoryFrame,
  IrregularLayout,
  IrregularLayoutScoreSummary
} from '@shared/irregular/domain.js'
import type {
  IrregularComputeResult,
  IrregularStateSnapshot
} from './computeIrregularNesting.js'

const IRREGULAR_BEAM_STRATEGY_ID = 'irregular-convex-windowed-beam'
const IRREGULAR_BEAM_STRATEGY_LABEL = 'Irregular convex windowed beam'

/** Real protocol-facing output derived from one completed irregular beam run. */
export interface IrregularWorkerOutput {
  readonly result: NestingResult
  readonly historyFrames: ReadonlyArray<IrregularHistoryFrame>
}

/** Stable worker-run identifier shared by result output and every history frame. */
export function irregularStrategyRunId(request: NestingRequest): string {
  return request.strategyRunId ?? `${request.jobId}-${IRREGULAR_BEAM_STRATEGY_ID}`
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
  return new IrregularHistoryFrame({
    kind: 'irregular',
    frameId: `${input.strategyRunId}:${snapshot.stepIndex}:${snapshot.beamRank}`,
    jobId: input.request.jobId,
    strategyRunId: input.strategyRunId,
    strategyLabel: IRREGULAR_BEAM_STRATEGY_LABEL,
    stepIndex: snapshot.stepIndex,
    title: snapshot.stepIndex === 0 ? 'initial-beam' : 'beam-state-selected',
    placements: snapshot.state.placedCollisionGeometries.map(({ placement }) => placement),
    remainingPieceIds: snapshot.state.remainingPreparedPieces.map(
      (piece) => piece.pieceId ?? piece.source.id
    ),
    unplacedPieceIds: snapshot.state.unplacedPieceIds,
    beamRank: snapshot.beamRank,
    beamWidth: input.beamWidth,
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
  const strategyRunId = irregularStrategyRunId(input.request)
  const layout = new IrregularLayout({
    kind: 'irregular',
    placements: input.computed.placedCollisionGeometries.map(({ placement }) => placement),
    unplacedPieceIds: input.computed.unplacedPieceIds,
    score: scoreSummary(input.computed),
    source: 'beam',
    status: 'completed',
    diagnostics: input.computed.diagnostics
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
    strategyId: IRREGULAR_BEAM_STRATEGY_ID,
    strategyLabel: IRREGULAR_BEAM_STRATEGY_LABEL,
    strategyDescription:
      'Deterministic convex NFP/IFP search with configurable windowed beam retention.',
    sortedPieceIds: input.computed.sortedPieceIds,
    placements: [],
    unplacedPieceIds: input.computed.unplacedPieceIds,
    layout,
    elapsedMs: input.algorithmBenchmark.elapsedMs,
    pieceCount: input.request.pieces.length,
    algorithmBenchmark: input.algorithmBenchmark
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
      preparedPieces: input.request.pieces
    }),
    historyFrames
  }
}

function scoreSummary(computed: IrregularComputeResult): IrregularLayoutScoreSummary {
  const score = computed.score
  return new IrregularLayoutScoreSummary({
    unplacedCount: score.unplacedCount,
    largestNetFreeMaterialRegionAreaMm2: score.largestNetFreeMaterialRegionAreaMm2,
    freeMaterialRegionCount: score.freeMaterialRegionCount,
    freeMaterialHoleCount: score.freeMaterialHoleCount,
    freeMaterialSliverMetric: score.freeMaterialSliverMetric,
    collisionBoundsWorstNormalizedSheetConsumption:
      score.collisionBoundsWorstNormalizedSheetConsumption,
    collisionBoundsNormalizedSpanSum: score.collisionBoundsNormalizedSpanSum,
    collisionBoundsAreaMm2: score.collisionBoundsAreaMm2,
    collisionBoundsSpanMm: score.collisionBoundsSpanMm
  })
}
