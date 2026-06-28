import { randomUUID } from 'node:crypto'
import { sortPiecesForNesting } from './sortPiecesForNesting.js'
import { selectFinalStrategyResult } from './selectFinalStrategyResult.js'
import type { NestingHistoryFrame, NestingRequest, NestingResult } from '@shared/domain/nesting.js'
import {
  NestingStrategyResult,
  NestingResult as NestingResultModel,
  NestingHistoryFrame as NestingHistoryFrameModel,
  PlateSnapshot,
  type NestingStrategyDefinition
} from '@shared/domain/nesting.js'
import { findStrategy, STRATEGY_DEFINITIONS } from '@shared/domain/strategies.js'
import {
  runMaxRectsBeamSearch,
  type NestingAlgorithmState,
  type NestingBeamState
} from './nestingAlgorithm.js'
import { makeStrategyOrders } from './strategyOrders.js'

export interface ComputeNestingOptions {
  readonly emitFrame: (frame: NestingHistoryFrame) => void
}

/**
 * Build a stub NestingResult for the still-missing nesting algorithm.
 *
 * This is the worker-facing orchestration wrapper: it resolves configured
 * strategy ids, adapts each strategy into algorithm ordering hooks, calls the
 * algorithm-core boundary, emits history through the worker callback, and wraps
 * the core outcome into protocol-facing strategy / result envelopes.
 *
 * No real placements, free rectangles, beam candidates, split events, or
 * cross-strategy scoring are produced.
 */
export function computeNestingStub(
  request: NestingRequest,
  elapsedMs: number,
  options: ComputeNestingOptions
): NestingResult {
  const sortedPieces = sortPiecesForNesting(request.pieces)
  const pieceIds = sortedPieces.map((piece) => piece.id)

  // build one stub strategy result per requested strategy id. Unrecognized
  // ids get a generic stub entry so the response shape stays stable when the
  // user wires a custom algorithm version with its own strategy ids. Strategy
  // ids select configured ordering rules; they are not part of the core
  // placement algorithm itself.
  const strategyIds = resolveStrategyIds(request)
  const strategyResults: NestingStrategyResult[] = []
  for (const [index, strategyId] of strategyIds.entries()) {
    const def = findStrategy(strategyId)
    const label = def?.label ?? strategyId
    const description = def?.description
    const strategyRunId = `run-${index + 1}-${strategyId}`
    const outcome = runStrategyStub(request, sortedPieces, def, strategyRunId, label, options)
    strategyResults.push(
      NestingStrategyResult.stub({
        strategyRunId,
        strategyId,
        strategyLabel: label,
        ...(description !== undefined ? { strategyDescription: description } : {}),
        sortedPieceIds: outcome.sortedPieceIds,
        elapsedMs,
        pieceCount: request.pieces.length
      })
    )
  }

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

function runStrategyStub(
  request: NestingRequest,
  sortedPieces: ReadonlyArray<NestingRequest['pieces'][number]>,
  strategy: NestingStrategyDefinition | undefined,
  strategyRunId: string,
  strategyLabel: string,
  options: ComputeNestingOptions
) {
  const orders = makeStrategyOrders(strategy)
  return runMaxRectsBeamSearch({
    sheet: request.sheet,
    pieces: sortedPieces,
    freeRectangleOrder: orders.freeRectangleOrder,
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
      createdAt
    })
  )
}

/**
 * Pick which strategy results belong in the final envelope for a given
 * request. Centralized so the manual / best / top N logic lives in one
 * place when the user writes the final-selection layer.
 */
function resolveStrategyIds(request: NestingRequest): ReadonlyArray<string> {
  if (request.options.strategySelectionMode === 'all_configured') {
    return STRATEGY_DEFINITIONS.map((s) => s.id)
  }
  if (request.options.strategyIds.length > 0) {
    return request.options.strategyIds
  }
  return [STRATEGY_DEFINITIONS[0]?.id ?? 'balanced-preserve-free-then-bottom-left']
}
