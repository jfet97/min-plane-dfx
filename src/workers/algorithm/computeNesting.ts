import { randomUUID } from 'node:crypto'
import { sortPiecesForNesting } from './sortPiecesForNesting.js'
import { selectFinalStrategyResult } from './selectFinalStrategyResult.js'
import type {
  LayoutSelectionStrategyDefinition,
  NestingHistoryFrame,
  NestingRequest,
  NestingResult,
  NestingStrategyDefinition
} from '@shared/domain/nesting.js'
import {
  NestingStrategyResult,
  NestingResult as NestingResultModel,
  NestingHistoryFrame as NestingHistoryFrameModel,
  BeamStateSnapshot,
  PlateSnapshot
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

export interface ComputeNestingOptions {
  readonly emitFrame: (frame: NestingHistoryFrame) => void
}

const BEAM_SEARCH_STRATEGY_ID = 'maxrects-beam-search'
const BEAM_SEARCH_STRATEGY_LABEL = 'MaxRects beam search'

/**
 * Worker-facing orchestration wrapper for a nesting run.
 *
 * It resolves configured strategy ids, adapts them into ordering hooks, calls
 * the algorithm core, translates algorithm state into history frames, and wraps
 * the core outcome into protocol-facing result envelopes.
 */
export function computeNesting(
  request: NestingRequest,
  elapsedMs: number,
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
  const strategyRunId = `run-1-${BEAM_SEARCH_STRATEGY_ID}`

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
      pieceCount: request.pieces.length
    })
  ]

  // final selection is trivial while there is one result row, but kept isolated
  const selected = selectFinalStrategyResult(strategyResults, request)

  // selected row fields become the top-level result summary
  const aggregatedPlacements = selected?.placements ?? []
  const aggregatedUnplaced = selected?.unplacedPieceIds ?? outcome.unplacedPieceIds

  return NestingResultModel.fromAlgorithm({
    request,
    strategyResults,
    ...(selected ? { selectedStrategyRunId: selected.strategyRunId } : {}),
    sortedPieceIds: outcome.sortedPieceIds,
    placements: aggregatedPlacements,
    unplacedPieceIds: aggregatedUnplaced,
    elapsedMs
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
) {
  // json strategy definitions become executable `Order` instances here
  const orders = makeStrategyOrders(candidateStrategies, layoutSelectionStrategy)
  return runMaxRectsBeamSearch({
    sheet: request.sheet,
    pieces: sortedPieces,
    beamWidth,
    candidateOrder: orders.candidateOrder,
    stateOrder: orders.stateOrder,
    hooks: {
      onEvent: (event) => {
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
        }
      }
    }
  })
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
  const createdAt = new Date().toISOString()
  return beamMembers(state).map((member, beamRank) =>
    NestingHistoryFrameModel.initialBeamSnapshot({
      frameId: randomUUID(),
      request,
      strategyRunId: runId,
      strategyLabel,
      beamRank,
      plate: new PlateSnapshot({
        placements: [...member.placements],
        freeRectangles: [...member.freeRectangles]
      }),
      state: new BeamStateSnapshot({
        remainingPieceIds: member.remainingPieces.map((piece) => piece.id),
        unplacedPieceIds: member.unplacedPieces.map((piece) => piece.id)
      }),
      createdAt
    })
  )
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
