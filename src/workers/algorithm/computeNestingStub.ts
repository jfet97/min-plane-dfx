import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { sortPiecesForNesting } from './sortPiecesForNesting.js'
import { selectFinalStrategyResult } from './selectFinalStrategyResult.js'
import type {
  NestingHistoryFrame,
  NestingRequest,
  NestingResult,
  NestingStrategyResult
} from '@shared/domain/nesting.js'
import { findStrategy, STRATEGY_DEFINITIONS } from '@shared/domain/strategies.js'

export interface ComputeNestingOptions<R = never, E = never> {
  readonly emitFrame: (frame: NestingHistoryFrame) => Effect.Effect<void, E, R>
}

/**
 * Build a stub NestingResult for the still-missing nesting algorithm.
 *
 * Each strategy id in the request becomes a single stub NestingStrategyResult.
 * The cross-strategy selection layer then picks one (or top N) for the final
 * envelope. No real placements, free rectangles, beam candidates, split
 * events, or cross-strategy scoring are produced.
 *
 * The future real algorithm replaces only `sortPiecesForNesting`,
 * `selectFinalStrategyResult`, and the per-strategy body here. The worker
 * protocol, IPC, validation, and UI boundaries stay stable.
 */
export function computeNestingStub<R = never, E = never>(
  request: NestingRequest,
  elapsedMs: number,
  options: ComputeNestingOptions<R, E>
): Effect.Effect<NestingResult, E, R> {
  return Effect.gen(function* () {
    const sortedPieces = sortPiecesForNesting(request.pieces)
    const pieceIds = sortedPieces.map((piece) => piece.id)

    // build one stub strategy result per requested strategy id. Unrecognized
    // ids get a generic stub entry so the response shape stays stable when the
    // user wires a custom algorithm version with its own strategy ids.
    const strategyIds = resolveStrategyIds(request)
    const strategyResults: NestingStrategyResult[] = []
    for (const [index, strategyId] of strategyIds.entries()) {
      const def = findStrategy(strategyId)
      const label = def?.label ?? strategyId
      const description = def?.description
      const strategyRunId = `run-${index + 1}-${strategyId}`
      strategyResults.push({
        strategyRunId,
        strategyId,
        strategyLabel: label,
        ...(description !== undefined ? { strategyDescription: description } : {}),
        status: 'stub',
        sortedPieceIds: pieceIds,
        placements: [],
        unplacedPieceIds: pieceIds,
        warnings: [
          {
            code: 'algorithm_not_implemented',
            message: `Strategy "${strategyId}" is intentionally not implemented yet.`
          }
        ],
        stats: {
          elapsedMs,
          pieceCount: request.pieces.length
        }
      })

      yield* options.emitFrame(buildInitialFrame(request, strategyRunId, label))
    }

    const selected = selectFinalStrategyResult(strategyResults, request)

    const aggregatedPlacements = selected?.placements ?? []
    const aggregatedUnplaced = selected?.unplacedPieceIds ?? pieceIds

    return {
      version: 1,
      jobId: request.jobId,
      status: 'stub',
      strategyResults,
      ...(selected ? { selectedStrategyRunId: selected.strategyRunId } : {}),
      sortedPieceIds: pieceIds,
      placements: aggregatedPlacements,
      unplacedPieceIds: aggregatedUnplaced,
      warnings: [
        {
          code: 'algorithm_not_implemented',
          message: 'The nesting algorithm is intentionally not implemented yet.'
        }
      ],
      stats: {
        elapsedMs,
        pieceCount: request.pieces.length
      }
    }
  })
}

function buildInitialFrame(
  request: NestingRequest,
  runId: string,
  strategyLabel: string
): NestingHistoryFrame {
  return {
    frameId: randomUUID(),
    jobId: request.jobId,
    strategyRunId: runId,
    strategyLabel,
    stepIndex: 0,
    beamRank: 0,
    title: 'stub-initial',
    plate: { placements: [], freeRectangles: [] },
    createdAt: new Date().toISOString()
  }
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
