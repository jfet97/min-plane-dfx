import { describe, expect, it } from 'vitest'
import { Order } from 'effect'
import { sortPiecesForNesting } from '../../src/workers/algorithm/sortPiecesForNesting.js'
import { computeNestingStub } from '../../src/workers/algorithm/computeNestingStub.js'
import { selectFinalStrategyResult } from '../../src/workers/algorithm/selectFinalStrategyResult.js'
import {
  makeBottomLeftPlacement,
  makeTopLeftPlacement
} from '../../src/workers/algorithm/candidateGeneration.js'
import {
  runMaxRectsBeamSearch,
  type NestingAlgorithmEvent,
  type NestingAlgorithmState
} from '../../src/workers/algorithm/nestingAlgorithm.js'
import {
  DEFAULT_STRATEGY_ID,
  STRATEGY_DEFINITIONS,
  findStrategy
} from '../../src/shared/domain/strategies.js'
import type {
  NestingRequest,
  PreparedPiece,
  NestingOptions,
  NestingStrategyResult,
  NestingHistoryFrame
} from '@shared/domain/nesting.js'
import { FreeRectangle } from '@shared/domain/nesting.js'
import type { JobId, PieceId } from '@shared/domain/ids.js'

function piece(id: string): PreparedPiece {
  return {
    id: id as PreparedPiece['id'],
    sourcePieceId: id as PreparedPiece['id'],
    realBounds: { x: 0, y: 0, width: 10, height: 5 },
    paddedBounds: { x: 0, y: 0, width: 14, height: 9, longestEdge: 14, area: 126, imbalance: 5 },
    padding: 2,
    allowRotation: true
  }
}

function options(overrides: Partial<NestingOptions> = {}): NestingOptions {
  return {
    allowGlobalRotation: true,
    timeoutMs: 5000,
    workerMode: 'stub',
    historyMode: 'final',
    historyScope: 'winning_path',
    strategySelectionMode: 'single',
    strategyIds: [DEFAULT_STRATEGY_ID],
    finalSelectionMode: 'manual',
    ...overrides
  }
}

function baseRequest(overrides: Partial<NestingRequest> = {}): NestingRequest {
  return {
    version: 1,
    jobId: 'job-1' as JobId,
    sheet: { width: 100, height: 100, label: 'default' },
    padding: 2,
    pieces: [piece('a'), piece('b')],
    options: options(),
    ...overrides
  }
}

function runNestingStub(request: NestingRequest, elapsedMs: number) {
  return computeNestingStub(request, elapsedMs, {
    emitFrame: () => {}
  })
}

describe('sortPiecesForNesting', () => {
  it('returns the same array contents in the same order', () => {
    const input = [piece('a'), piece('b'), piece('c')]
    const output = sortPiecesForNesting(input)
    expect(output.map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty array when given an empty array', () => {
    expect(sortPiecesForNesting([])).toEqual([])
  })
})

describe('runMaxRectsBeamSearch', () => {
  it('exposes algorithm events without creating placements or Effectful history', () => {
    const initialStates: NestingAlgorithmState[] = []
    const events: NestingAlgorithmEvent.Event[] = []
    const result = runMaxRectsBeamSearch({
      sheet: baseRequest().sheet,
      pieces: [piece('a'), piece('b')],
      freeRectangleOrder: () => Order.make(() => 0),
      stateOrder: () => Order.make(() => 0),
      hooks: {
        onEvent: (event) => {
          events.push(event)
          if (event.type === 'initial_state') {
            initialStates.push(event.state)
          }
        }
      }
    })

    expect(events.map((event) => event.type)).toEqual(['initial_state', 'completed'])
    expect(initialStates.length).toBe(1)
    expect(initialStates[0]?.top.placements).toEqual([])
    expect(initialStates[0]?.alternatives).toEqual([])
    expect(initialStates[0]?.top.freeRectangles).toHaveLength(1)
    expect(initialStates[0]?.top.freeRectangles[0]).toMatchObject({
      x: 0,
      y: 0,
      width: 100,
      height: 100
    })
    expect(initialStates[0]?.top.freeRectangles[0]?.id).toEqual(expect.any(String))
    expect(initialStates[0]?.top.remainingPieces.map((p) => p.id)).toEqual(['a', 'b'])
    expect(result.placements).toEqual([])
    expect(result.unplacedPieceIds).toEqual(['a', 'b'])
  })
})

describe('makeBottomLeftPlacement', () => {
  it('places the unrotated piece at the free rectangle origin', () => {
    const placement = makeBottomLeftPlacement(
      new FreeRectangle({ x: 20, y: 10, width: 100, height: 80 }),
      piece('a'),
      false
    )

    expect(placement).toMatchObject({
      pieceId: 'a',
      x: 20,
      y: 10,
      width: 14,
      height: 9,
      rotation: 0
    })
  })

  it('swaps padded dimensions for rotated placements', () => {
    const placement = makeBottomLeftPlacement(
      new FreeRectangle({ x: 20, y: 10, width: 100, height: 80 }),
      piece('a'),
      true
    )

    expect(placement).toMatchObject({
      pieceId: 'a',
      x: 20,
      y: 10,
      width: 9,
      height: 14,
      rotation: 90
    })
  })
})

describe('makeTopLeftPlacement', () => {
  it('places the unrotated piece at the top-left of the free rectangle', () => {
    const placement = makeTopLeftPlacement(
      new FreeRectangle({ x: 20, y: 10, width: 100, height: 80 }),
      piece('a'),
      false
    )

    expect(placement).toMatchObject({
      pieceId: 'a',
      x: 20,
      y: 81,
      width: 14,
      height: 9,
      rotation: 0
    })
  })

  it('uses the rotated height when anchoring to the top edge', () => {
    const placement = makeTopLeftPlacement(
      new FreeRectangle({ x: 20, y: 10, width: 100, height: 80 }),
      piece('a'),
      true
    )

    expect(placement).toMatchObject({
      pieceId: 'a',
      x: 20,
      y: 76,
      width: 9,
      height: 14,
      rotation: 90
    })
  })
})

describe('selectFinalStrategyResult', () => {
  it('returns the first strategy result when one or more are available', () => {
    const runA = makeStrategy('run-1', 'balanced-preserve-free-then-bottom-left')
    const runB = makeStrategy('run-2', 'short-fill-short-side-fit-then-bottom-left')
    const selected = selectFinalStrategyResult([runA, runB], baseRequest())
    expect(selected?.strategyRunId).toBe('run-1')
  })

  it('returns null when no strategy results are available', () => {
    expect(selectFinalStrategyResult([], baseRequest())).toBeNull()
  })

  it('does not invent fake scoring for `best` or `top_n`', () => {
    const runA = makeStrategy('run-1', 'balanced-preserve-free-then-bottom-left')
    const runB = makeStrategy('run-2', 'short-fill-short-side-fit-then-bottom-left')
    const reqBest = baseRequest({ options: options({ finalSelectionMode: 'best' }) })
    const reqTopN = baseRequest({ options: options({ finalSelectionMode: 'top_n' }) })
    expect(selectFinalStrategyResult([runA, runB], reqBest)?.strategyRunId).toBe('run-1')
    expect(selectFinalStrategyResult([runA, runB], reqTopN)?.strategyRunId).toBe('run-1')
  })
})

describe('computeNestingStub', () => {
  it('returns a stub result with status="stub"', () => {
    const result = runNestingStub(baseRequest(), 12)
    expect(result.status).toBe('stub')
  })

  it('emits empty placements at every level', () => {
    const result = runNestingStub(baseRequest(), 12)
    expect(result.placements.length).toBe(0)
    for (const strategy of result.strategyResults) {
      expect(strategy.placements.length).toBe(0)
    }
  })

  it('preserves input order in sortedPieceIds at the top level', () => {
    const result = runNestingStub(baseRequest(), 12)
    expect(result.sortedPieceIds).toEqual(['a', 'b'])
  })

  it('marks every input piece as unplaced', () => {
    const result = runNestingStub(baseRequest(), 12)
    expect(result.unplacedPieceIds).toEqual(['a', 'b'])
  })

  it('emits one strategy result per requested strategy id', () => {
    const req = baseRequest({
      options: options({
        strategySelectionMode: 'single',
        strategyIds: [
          'balanced-preserve-free-then-bottom-left',
          'short-fill-short-side-fit-then-bottom-left'
        ]
      })
    })
    const result = runNestingStub(req, 5)
    expect(result.strategyResults.length).toBe(2)
    expect(result.strategyResults.map((s) => s.strategyId)).toEqual([
      'balanced-preserve-free-then-bottom-left',
      'short-fill-short-side-fit-then-bottom-left'
    ])
  })

  it('emits one strategy result per configured strategy when mode is all_configured', () => {
    const req = baseRequest({
      options: options({ strategySelectionMode: 'all_configured', strategyIds: [] })
    })
    const result = runNestingStub(req, 5)
    expect(result.strategyResults.length).toBe(STRATEGY_DEFINITIONS.length)
  })

  it('points selectedStrategyRunId at the first strategy run', () => {
    const req = baseRequest({
      options: options({
        strategyIds: [
          'balanced-preserve-free-then-bottom-left',
          'short-fill-short-side-fit-then-bottom-left'
        ]
      })
    })
    const result = runNestingStub(req, 5)
    expect(result.selectedStrategyRunId).toBe(result.strategyResults[0]?.strategyRunId)
  })

  it('emits the algorithm_not_implemented warning at every level', () => {
    const result = runNestingStub(baseRequest(), 0)
    expect(result.warnings.some((w) => w.code === 'algorithm_not_implemented')).toBe(true)
    for (const strategy of result.strategyResults) {
      expect(strategy.warnings.some((w) => w.code === 'algorithm_not_implemented')).toBe(true)
    }
  })

  it('does not produce any fake history, beam, or split events', () => {
    const result = runNestingStub(baseRequest(), 0)
    expect(result.historySummary).toBeUndefined()
    for (const strategy of result.strategyResults) {
      expect(strategy.historySummary).toBeUndefined()
    }
  })

  it('emits one initial history frame per strategy from the wrapper layer', () => {
    const frames: NestingHistoryFrame[] = []
    const req = baseRequest({
      options: options({
        strategyIds: [
          'balanced-preserve-free-then-bottom-left',
          'short-fill-short-side-fit-then-bottom-left'
        ]
      })
    })

    computeNestingStub(req, 0, {
      emitFrame: (frame) => {
        frames.push(frame)
      }
    })

    expect(frames.length).toBe(2)
    expect(frames.map((frame) => frame.strategyRunId)).toEqual([
      'run-1-balanced-preserve-free-then-bottom-left',
      'run-2-short-fill-short-side-fit-then-bottom-left'
    ])
    expect(frames.map((frame) => frame.beamRank)).toEqual([0, 0])
    expect(frames.every((frame) => frame.plate.freeRectangles.length === 1)).toBe(true)
  })

  it('records elapsed time and piece count in stats', () => {
    const result = runNestingStub(baseRequest(), 42)
    expect(result.stats.elapsedMs).toBe(42)
    expect(result.stats.pieceCount).toBe(2)
  })
})

describe('strategies data', () => {
  it('registers exactly eight initial strategy definitions', () => {
    expect(STRATEGY_DEFINITIONS.length).toBe(8)
  })

  it('keeps strategy ids descriptive (no opaque A.1 codes)', () => {
    for (const def of STRATEGY_DEFINITIONS) {
      expect(def.id).toMatch(/^[a-z]+(?:-[a-z]+)+$/)
      expect(def.label.length).toBeGreaterThan(0)
      expect(def.description.length).toBeGreaterThan(0)
    }
  })

  it('findStrategy returns the matching definition', () => {
    const def = findStrategy('short-fill-short-side-fit-then-bottom-left')
    expect(def?.label).toContain('Short-fill')
  })
})

function makeStrategy(runId: string, strategyId: string): NestingStrategyResult {
  return {
    strategyRunId: runId,
    strategyId,
    strategyLabel: strategyId,
    status: 'stub',
    sortedPieceIds: ['a' as PieceId],
    placements: [],
    unplacedPieceIds: ['a' as PieceId],
    warnings: [{ code: 'algorithm_not_implemented', message: 'stub' }],
    stats: { elapsedMs: 0, pieceCount: 1 }
  }
}
