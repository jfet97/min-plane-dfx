import { randomUUID } from 'node:crypto'
import { Schema } from 'effect'
import { PreparedPiece } from '@shared/domain/nesting.js'
import { sortPiecesForNesting } from './sortPiecesForNesting.js'
import { selectFinalStrategyResult } from './selectFinalStrategyResult.js'
import type {
  AlgorithmBenchmark,
  LayoutSelectionStrategyDefinition,
  NestingHistoryFrame,
  NestingRequest,
  NestingResult,
  NestingStrategyDefinition,
  Placement
} from '@shared/domain/nesting.js'
import {
  NestingStrategyResult,
  NestingResult as NestingResultModel,
  NestingHistoryFrame as NestingHistoryFrameModel,
  BeamStepTrace,
  BeamStateSnapshot,
  PlateSnapshot,
  NestingSubRun,
  NestingRunSummary
} from '@shared/domain/nesting.js'
import {
  DEFAULT_STRATEGY_ID,
  STRATEGY_DEFINITIONS,
  findStrategy
} from '@shared/domain/strategies.js'
import { findLayoutSelectionStrategy } from '@shared/domain/layoutSelectionStrategies.js'
import {
  K,
  runMaxRectsBeamSearch,
  type NestingAlgorithmState,
  type NestingBeamState
} from './nestingAlgorithm.js'
import { makeStrategyOrders } from './strategyOrders.js'
import type { PieceId } from '@shared/domain/ids.js'

export interface ComputeNestingOptions {
  readonly emitFrame: (frame: NestingHistoryFrame) => void
}

const BEAM_SEARCH_STRATEGY_ID = 'maxrects-beam-search'
const BEAM_SEARCH_STRATEGY_LABEL = 'MaxRects beam search'

interface RunBeamSearchOutcome {
  readonly sortedPieceIds: ReadonlyArray<PieceId>
  readonly placements: ReadonlyArray<Placement>
  readonly unplacedPieceIds: ReadonlyArray<PieceId>
  readonly algorithmBenchmark: AlgorithmBenchmark
}

/**
 * Worker-facing orchestration wrapper for a nesting run.
 *
 * It resolves configured strategy ids, adapts them into ordering hooks, calls
 * the algorithm core, translates algorithm state into history frames, and wraps
 * the core outcome into protocol-facing result envelopes.
 */
export function computeNesting(
  request: NestingRequest,
  options: ComputeNestingOptions
): NestingResult {
  // piece ordering is still a separate boundary so it can evolve independently
  const sortedPieces = sortPiecesForNesting(request.pieces)

  // selected candidate strategies are competing candidate orders in one beam run
  const candidateStrategyIds = resolveCandidateStrategyIds(request)
  const candidateStrategies = candidateStrategyIds.map(resolveCandidateStrategy)
  const layoutSelectionStrategy = resolveLayoutSelectionStrategy(
    request.options.layoutSelectionStrategyId
  )

  // beam width grows with the number of selected candidate-order strategies
  const beamWidth = K(candidateStrategyIds.length)
  const strategyRunId = request.strategyRunId ?? `run-1-${BEAM_SEARCH_STRATEGY_ID}`

  // the core returns plain algorithm output; this wrapper owns protocol models
  const outcome = runBeamSearch(
    request,
    sortedPieces,
    candidateStrategies,
    layoutSelectionStrategy,
    strategyRunId,
    BEAM_SEARCH_STRATEGY_LABEL,
    beamWidth,
    options
  )
  const elapsedMs = outcome.algorithmBenchmark.elapsedMs

  // the UI still expects result rows; the beam search is currently one row
  const strategyResults = [
    NestingStrategyResult.fromAlgorithm({
      strategyRunId,
      strategyId: BEAM_SEARCH_STRATEGY_ID,
      strategyLabel: BEAM_SEARCH_STRATEGY_LABEL,
      strategyDescription: describeBeamSearchRun(
        candidateStrategyIds,
        request.options.layoutSelectionStrategyId
      ),
      sortedPieceIds: outcome.sortedPieceIds,
      placements: outcome.placements,
      unplacedPieceIds: outcome.unplacedPieceIds,
      elapsedMs,
      pieceCount: request.pieces.length,
      algorithmBenchmark: outcome.algorithmBenchmark
    })
  ]

  // final selection is trivial while there is one result row, but kept isolated
  const selected = selectFinalStrategyResult(strategyResults, request)

  // selected row fields become the top-level result summary
  const aggregatedPlacements = selected?.placements ?? []
  const aggregatedUnplaced = selected?.unplacedPieceIds ?? outcome.unplacedPieceIds

  // a single worker call represents one subrun; include its summary so the
  // renderer can aggregate multi-plate CSV runs without re-deriving metadata
  const requestPieceIds = request.pieces.map((piece) => piece.id)
  const subRun = new NestingSubRun({
    subRunId: strategyRunId,
    parentRunId: request.strategyRunId ?? request.jobId,
    index: 0,
    sheet: request.sheet,
    padding: request.padding,
    options: request.options,
    placements: aggregatedPlacements,
    unplacedPieceIds: aggregatedUnplaced,
    pieceIds: requestPieceIds,
    requestPieceIds
  })
  const subRuns = [subRun]
  const runSummary = new NestingRunSummary({
    runId: strategyRunId,
    subRuns,
    totalPlaced: aggregatedPlacements.length,
    totalUnplaced: aggregatedUnplaced.length,
    totalSheetAreaMm2: request.sheet.width * request.sheet.height * subRuns.length,
    usedAreaMm2: aggregatedPlacements.reduce(
      (sum, placement) => sum + placement.width * placement.height,
      0
    )
  })

  const preparedPieces = request.pieces.map((piece) =>
    Schema.decodeUnknownSync(PreparedPiece)(piece)
  )

  return NestingResultModel.fromAlgorithm({
    request,
    strategyResults,
    ...(selected ? { selectedStrategyRunId: selected.strategyRunId } : {}),
    sortedPieceIds: outcome.sortedPieceIds,
    placements: aggregatedPlacements,
    unplacedPieceIds: aggregatedUnplaced,
    elapsedMs,
    algorithmBenchmark: outcome.algorithmBenchmark,
    runSummary,
    preparedPieces
  })
}

function runBeamSearch(
  request: NestingRequest,
  sortedPieces: ReadonlyArray<NestingRequest['pieces'][number]>,
  candidateStrategies: ReadonlyArray<NestingStrategyDefinition>,
  layoutSelectionStrategy: LayoutSelectionStrategyDefinition,
  strategyRunId: string,
  strategyLabel: string,
  beamWidth: number,
  options: ComputeNestingOptions
): RunBeamSearchOutcome {
  // json strategy definitions become executable `Order` instances here
  const orders = makeStrategyOrders(request.sheet, candidateStrategies, layoutSelectionStrategy)
  let algorithmBenchmark: AlgorithmBenchmark | null = null
  const stepTraces = new Map<
    number,
    { readonly beamSize: number; readonly candidateCount: number }
  >()
  // placements per (stepIndex, beamRank) so state_selected can attribute the winner
  const placementsByStep = new Map<
    number,
    Map<number, { readonly candidateId: string; readonly candidateOrderId: string }>
  >()
  const outcome = runMaxRectsBeamSearch({
    sheet: request.sheet,
    pieces: sortedPieces,
    beamWidth,
    candidateOrder: orders.candidateOrder,
    stateOrder: orders.stateOrder,
    hooks: {
      onEvent: (event) => {
        if (event.type === 'algorithm_started') {
          return
        }
        if (event.type === 'completed') {
          algorithmBenchmark = event.benchmark
          return
        }
        if (event.type === 'beam_step') {
          stepTraces.set(event.stepIndex, {
            beamSize: event.beamSize,
            candidateCount: event.candidateCount
          })
          return
        }
        if (event.type === 'placement_applied') {
          // track so the subsequent state-selected event can attribute the move
          let perRank = placementsByStep.get(event.stepIndex)
          if (perRank === undefined) {
            perRank = new Map()
            placementsByStep.set(event.stepIndex, perRank)
          }
          perRank.set(event.beamRank, {
            candidateId: event.candidateId,
            candidateOrderId: event.candidateOrderId
          })
          return
        }
        if (event.type === 'initial_state') {
          // history is a worker concern, so algorithm state is translated here
          for (const frame of buildStateFrames(
            request,
            strategyRunId,
            strategyLabel,
            event.state
          )) {
            options.emitFrame(frame)
          }
          return
        }
        if (event.type === 'state_selected') {
          // algorithm step 0 follows the initial seed, so history displays it as step 1
          const frameStepIndex = event.stepIndex + 1
          const stepTrace = stepTraces.get(event.stepIndex)
          const applied = placementsByStep.get(event.stepIndex)?.get(event.beamRank)
          const beam =
            stepTrace === undefined
              ? {}
              : {
                  beam: new BeamStepTrace({
                    strategyRunId,
                    strategyLabel,
                    stepIndex: frameStepIndex,
                    insertedPieceId: event.state.placements.at(-1)?.pieceId ?? null,
                    beamRank: event.beamRank,
                    beamWidth,
                    candidateCount: stepTrace.candidateCount,
                    // null when no placement was applied for this step/rank
                    selectedCandidateId: applied?.candidateId ?? null,
                    selectedCandidateOrderId: applied?.candidateOrderId ?? null
                  })
                }
          options.emitFrame(
            buildBeamStateFrame({
              request,
              runId: strategyRunId,
              strategyLabel,
              member: event.state,
              stepIndex: frameStepIndex,
              beamRank: event.beamRank,
              title: 'beam-state-selected',
              ...beam
            })
          )
        }
      }
    }
  })
  return { ...outcome, algorithmBenchmark: requireAlgorithmBenchmark(algorithmBenchmark) }
}

function requireAlgorithmBenchmark(benchmark: AlgorithmBenchmark | null): AlgorithmBenchmark {
  if (benchmark === null) {
    throw new Error('Algorithm completed without emitting benchmark timings.')
  }
  return benchmark
}

function beamMembers(state: NestingAlgorithmState): ReadonlyArray<NestingBeamState> {
  return [state.top, ...state.alternatives]
}

/**
 * Convert the retained beam into history frames.
 *
 * Each retained state becomes one frame with its `beamRank`, so the renderer can
 * show the top branch and the alternative branches without knowing algorithm
 * internals.
 */
function buildStateFrames(
  request: NestingRequest,
  runId: string,
  strategyLabel: string,
  state: NestingAlgorithmState
): ReadonlyArray<NestingHistoryFrame> {
  return beamMembers(state).map((member, beamRank) =>
    buildBeamStateFrame({
      request,
      runId,
      strategyLabel,
      member,
      stepIndex: 0,
      beamRank,
      title: 'initial-beam'
    })
  )
}

function buildBeamStateFrame(input: {
  readonly request: NestingRequest
  readonly runId: string
  readonly strategyLabel: string
  readonly member: NestingBeamState
  readonly stepIndex: number
  readonly beamRank: number
  readonly title: string
  readonly beam?: BeamStepTrace
}): NestingHistoryFrame {
  return new NestingHistoryFrameModel({
    frameId: randomUUID(),
    jobId: input.request.jobId,
    strategyRunId: input.runId,
    strategyLabel: input.strategyLabel,
    stepIndex: input.stepIndex,
    beamRank: input.beamRank,
    title: input.title,
    plate: new PlateSnapshot({
      placements: [...input.member.placements],
      freeRectangles: [...input.member.freeRectangles]
    }),
    state: new BeamStateSnapshot({
      remainingPieceIds: input.member.remainingPieces.map((piece) => piece.id),
      unplacedPieceIds: input.member.unplacedPieces.map((piece) => piece.id)
    }),
    ...(input.beam !== undefined ? { beam: input.beam } : {}),
    createdAt: new Date().toISOString()
  })
}

function describeBeamSearchRun(
  candidateStrategyIds: ReadonlyArray<string>,
  layoutSelectionStrategyId: string
): string {
  return `Candidate orders: ${candidateStrategyIds.join(', ')}. Layout selection: ${layoutSelectionStrategyId}.`
}

// request ids are optional in the UI; default to the first configured strategy
function resolveCandidateStrategyIds(request: NestingRequest): ReadonlyArray<string> {
  if (request.options.strategySelectionMode === 'all_configured') {
    return STRATEGY_DEFINITIONS.map((s) => s.id)
  }
  if (request.options.strategyIds.length > 0) {
    return request.options.strategyIds
  }
  return [DEFAULT_STRATEGY_ID]
}

// fail fast at the worker boundary if a persisted strategy id is unknown
function resolveCandidateStrategy(id: string): NestingStrategyDefinition {
  const strategy = findStrategy(id)
  if (strategy === undefined) {
    throw new Error(`Unknown candidate strategy id: ${id}`)
  }
  return strategy
}

// layout selection is required because it decides beam survivors after expansion
function resolveLayoutSelectionStrategy(id: string): LayoutSelectionStrategyDefinition {
  const strategy = findLayoutSelectionStrategy(id)
  if (strategy === undefined) {
    throw new Error(`Unknown layout selection strategy id: ${id}`)
  }
  return strategy
}
