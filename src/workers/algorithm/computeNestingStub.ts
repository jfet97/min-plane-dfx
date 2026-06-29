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
 * Build a stub NestingResult for the still-missing nesting algorithm.
 *
 * This is the worker-facing orchestration wrapper: it resolves configured
 * candidate strategy ids, adapts them into algorithm ordering hooks, calls the
 * algorithm-core boundary, emits history through the worker callback, and wraps
 * the core outcome into protocol-facing result envelopes.
 *
 * No real placements, free rectangles, beam candidates, split events, or
 * scoring are produced.
 */
export function computeNestingStub(
  request: NestingRequest,
  elapsedMs: number,
  options: ComputeNestingOptions
): NestingResult {
  const sortedPieces = sortPiecesForNesting(request.pieces)
  const pieceIds = sortedPieces.map((piece) => piece.id)

  // selected candidate strategies are alternatives inside one beam run
  const candidateStrategyIds = resolveCandidateStrategyIds(request)
  const candidateStrategies = candidateStrategyIds.map((id) => findStrategy(id))
  const layoutSelectionStrategy = findLayoutSelectionStrategy(
    request.options.layoutSelectionStrategyId
  )
  const beamWidth = K(candidateStrategyIds.length)
  const strategyRunId = `run-1-${BEAM_SEARCH_STRATEGY_ID}`
  const outcome = runBeamSearchStub(
    request,
    sortedPieces,
    candidateStrategies,
    layoutSelectionStrategy,
    strategyRunId,
    BEAM_SEARCH_STRATEGY_LABEL,
    beamWidth,
    options
  )
  const strategyResults = [
    NestingStrategyResult.stub({
      strategyRunId,
      strategyId: BEAM_SEARCH_STRATEGY_ID,
      strategyLabel: BEAM_SEARCH_STRATEGY_LABEL,
      strategyDescription: describeBeamSearchRun(
        candidateStrategyIds,
        request.options.layoutSelectionStrategyId
      ),
      sortedPieceIds: outcome.sortedPieceIds,
      elapsedMs,
      pieceCount: request.pieces.length
    })
  ]

  const selected = selectFinalStrategyResult(strategyResults, request)

  const aggregatedPlacements = selected?.placements ?? []
  const aggregatedUnplaced = selected?.unplacedPieceIds ?? pieceIds

  return NestingResultModel.stub({
    request,
    strategyResults,
    ...(selected ? { selectedStrategyRunId: selected.strategyRunId } : {}),
    sortedPieceIds: pieceIds,
    placements: aggregatedPlacements,
    unplacedPieceIds: aggregatedUnplaced,
    elapsedMs
  })
}

function runBeamSearchStub(
  request: NestingRequest,
  sortedPieces: ReadonlyArray<NestingRequest['pieces'][number]>,
  candidateStrategies: ReadonlyArray<NestingStrategyDefinition | undefined>,
  layoutSelectionStrategy: LayoutSelectionStrategyDefinition | undefined,
  strategyRunId: string,
  strategyLabel: string,
  beamWidth: number,
  options: ComputeNestingOptions
) {
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

function resolveCandidateStrategyIds(request: NestingRequest): ReadonlyArray<string> {
  if (request.options.strategySelectionMode === 'all_configured') {
    return STRATEGY_DEFINITIONS.map((s) => s.id)
  }
  if (request.options.strategyIds.length > 0) {
    return request.options.strategyIds
  }
  return [DEFAULT_STRATEGY_ID]
}
