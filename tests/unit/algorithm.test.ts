import { describe, expect, it } from 'vitest'
import { Order } from 'effect'
import { sortPiecesForNesting } from '../../src/workers/algorithm/sortPiecesForNesting.js'
import { computeNesting } from '../../src/workers/algorithm/computeNesting.js'
import { selectFinalStrategyResult } from '../../src/workers/algorithm/selectFinalStrategyResult.js'
import { makeStrategyOrders } from '../../src/workers/algorithm/strategyOrders.js'
import {
  applyCandidate,
  NestingAlgorithmCandidate
} from '../../src/workers/algorithm/beam/candidates.js'
import { NestingBeamState } from '../../src/workers/algorithm/beam/state.js'
import {
  makeBottomLeftPlacement,
  makeTopLeftPlacement
} from '../../src/workers/algorithm/maxRects/placements.js'
import { FreeRectangles } from '../../src/workers/algorithm/maxRects/freeRectangles.js'
import {
  CandidateOrderEntry,
  K,
  initialState,
  runMaxRectsBeamSearch,
  type NestingAlgorithmEvent,
  type NestingAlgorithmState
} from '../../src/workers/algorithm/nestingAlgorithm.js'
import {
  ALL_STRATEGY_DEFINITIONS,
  DEFAULT_STRATEGY_ID,
  STRATEGY_DEFINITIONS,
  findStrategy
} from '../../src/shared/domain/strategies.js'
import {
  DEFAULT_LAYOUT_SELECTION_STRATEGY_ID,
  LAYOUT_SELECTION_STRATEGIES,
  findLayoutSelectionStrategy
} from '../../src/shared/domain/layoutSelectionStrategies.js'
import type {
  NestingRequest,
  PreparedPiece,
  NestingOptions,
  NestingStrategyResult,
  NestingHistoryFrame,
  Placement
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

function sizedPiece(id: string, width: number, height: number): PreparedPiece {
  return {
    ...piece(id),
    realBounds: { x: 0, y: 0, width, height },
    paddedBounds: {
      x: 0,
      y: 0,
      width,
      height,
      longestEdge: Math.max(width, height),
      area: width * height,
      imbalance: Math.abs(width - height)
    }
  }
}

function options(overrides: Partial<NestingOptions> = {}): NestingOptions {
  return {
    allowGlobalRotation: true,
    timeoutMs: 5000,
    workerMode: 'maxrects-beam-search',
    historyMode: 'final',
    historyScope: 'winning_path',
    strategySelectionMode: 'single',
    strategyIds: [DEFAULT_STRATEGY_ID],
    layoutSelectionStrategyId: DEFAULT_LAYOUT_SELECTION_STRATEGY_ID,
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

function runNesting(request: NestingRequest) {
  return computeNesting(request, {
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
  it('derives K from the selected strategy count with a minimum of five', () => {
    expect(K(1)).toBe(5)
    expect(K(2)).toBe(5)
    expect(K(4)).toBe(8)
    expect(K(8)).toBe(10)
  })

  it('builds the initial beam from the first two pieces and both orientations', () => {
    const state = initialState({
      sheet: baseRequest().sheet,
      pieces: [piece('a'), piece('b'), piece('c')],
      beamWidth: K(1)
    })
    const members = [state.top, ...state.alternatives]

    expect(members.length).toBe(4)
    expect(members.map((member) => member.placements[0]?.pieceId)).toEqual(['a', 'a', 'b', 'b'])
    expect(members.map((member) => member.placements[0]?.rotation)).toEqual([0, 90, 0, 90])
    expect(members.map((member) => member.remainingPieces.map((p) => p.id))).toEqual([
      ['b', 'c'],
      ['b', 'c'],
      ['a', 'c'],
      ['a', 'c']
    ])
    expect(members.map((member) => member.unplacedPieces)).toEqual([[], [], [], []])
    expect(members.every((member) => member.freeRectangles.length === 2)).toBe(true)
  })

  it('builds two initial beam states when only one piece exists', () => {
    const state = initialState({
      sheet: baseRequest().sheet,
      pieces: [piece('a')],
      beamWidth: K(1)
    })
    const members = [state.top, ...state.alternatives]

    expect(members.length).toBe(2)
    expect(members.map((member) => member.placements[0]?.rotation)).toEqual([0, 90])
    expect(members.map((member) => member.remainingPieces)).toEqual([[], []])
    expect(members.map((member) => member.unplacedPieces)).toEqual([[], []])
  })

  it('falls back to an empty beam state with no pieces', () => {
    const state = initialState({
      sheet: baseRequest().sheet,
      pieces: [],
      beamWidth: K(1)
    })

    expect(state.top.placements).toEqual([])
    expect(state.alternatives).toEqual([])
    expect(state.top.freeRectangles).toHaveLength(1)
    expect(state.top.remainingPieces).toEqual([])
    expect(state.top.unplacedPieces).toEqual([])
  })

  it('keeps failed seed attempts as states with the piece marked unplaced', () => {
    const state = initialState({
      sheet: { width: 10, height: 10, label: 'small' },
      pieces: [sizedPiece('a', 20, 10)],
      beamWidth: K(1)
    })
    const members = [state.top, ...state.alternatives]

    expect(members.length).toBe(2)
    expect(members.map((member) => member.placements)).toEqual([[], []])
    expect(members.map((member) => member.remainingPieces.map((p) => p.id))).toEqual([[], []])
    expect(members.map((member) => member.unplacedPieces.map((p) => p.id))).toEqual([['a'], ['a']])
    expect(members.every((member) => member.freeRectangles.length === 1)).toBe(true)
  })

  it('promotes a rotated seed when the unrotated seed does not fit', () => {
    const sheet = { width: 5, height: 10, label: 'rotated-only' }
    const layoutStrategy = requireDefined(findLayoutSelectionStrategy('compact-first'))
    const strategy = requireDefined(findStrategy(DEFAULT_STRATEGY_ID))
    const orders = makeStrategyOrders(sheet, [strategy], layoutStrategy)

    const result = runMaxRectsBeamSearch({
      sheet,
      pieces: [sizedPiece('a', 10, 5)],
      beamWidth: K(1),
      candidateOrder: orders.candidateOrder,
      stateOrder: orders.stateOrder
    })

    expect(result.placements).toMatchObject([
      { pieceId: 'a', width: 5, height: 10, rotation: 90 }
    ])
    expect(result.unplacedPieceIds).toEqual([])
  })

  it('removes a failed second seed from the future queue while preserving earlier pieces', () => {
    const state = initialState({
      sheet: { width: 10, height: 10, label: 'small' },
      pieces: [sizedPiece('a', 1, 1), sizedPiece('b', 20, 10)],
      beamWidth: K(1)
    })
    const members = [state.top, ...state.alternatives]

    expect(members[2]?.placements).toEqual([])
    expect(members[2]?.remainingPieces.map((p) => p.id)).toEqual(['a'])
    expect(members[2]?.unplacedPieces.map((p) => p.id)).toEqual(['b'])
  })

  it('does not reject a seed when the next remaining piece has no split space yet', () => {
    const state = initialState({
      sheet: { width: 10, height: 10, label: 'small' },
      pieces: [sizedPiece('a', 10, 10), sizedPiece('b', 1, 1)],
      beamWidth: K(1)
    })
    const members = [state.top, ...state.alternatives]

    expect(members.length).toBe(4)
    expect(members[0]?.placements[0]?.pieceId).toBe('a')
    expect(members[0]?.freeRectangles).toEqual([])
    expect(members[0]?.remainingPieces.map((p) => p.id)).toEqual(['b'])
    expect(members[0]?.unplacedPieces).toEqual([])
  })

  it('exposes algorithm events without creating Effectful history', () => {
    const initialStates: NestingAlgorithmState[] = []
    const events: NestingAlgorithmEvent[] = []
    const result = runMaxRectsBeamSearch({
      sheet: baseRequest().sheet,
      pieces: [piece('a'), piece('b')],
      beamWidth: K(1),
      candidateOrder: [
        new CandidateOrderEntry({ strategyId: 's1', order: Order.make(() => 0) })
      ],
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

    const eventTypes = events.map((event) => event.type)
    expect(eventTypes[0]).toBe('algorithm_started')
    expect(eventTypes[1]).toBe('initial_state')
    expect(eventTypes.at(-1)).toBe('completed')
    expect(eventTypes.filter((type) => type === 'beam_step')).toHaveLength(1)
    expect(eventTypes.filter((type) => type === 'placement_applied')).toHaveLength(8)
    expect(eventTypes.filter((type) => type === 'state_selected')).toHaveLength(K(1))
    expect(eventTypes).not.toContain('candidate_ranked')
    const completedEvent = events.find((event) => event.type === 'completed')
    expect(completedEvent?.benchmark.elapsedMs).toBeGreaterThanOrEqual(0)
    const beamStepEvent = events.find((event) => event.type === 'beam_step')
    expect(beamStepEvent?.beamSize).toBe(4)
    expect(beamStepEvent?.candidateCount).toBe(16)
    const appliedEvent = events.find((event) => event.type === 'placement_applied')
    expect(appliedEvent?.pieceId).toBe('b')
    expect(appliedEvent?.candidateOrderId).toBe('s1')
    expect(appliedEvent?.freeRectangleId).toBeDefined()
    expect(appliedEvent?.split.before.id).toBeDefined()
    expect(initialStates.length).toBe(1)
    expect(initialStates[0]?.top.placements[0]).toMatchObject({
      pieceId: 'a',
      x: 0,
      y: 0,
      width: 14,
      height: 9,
      rotation: 0
    })
    expect(initialStates[0]?.alternatives).toHaveLength(3)
    expect(initialStates[0]?.top.freeRectangles).toHaveLength(2)
    expect(initialStates[0]?.top.remainingPieces.map((p) => p.id)).toEqual(['b'])
    expect(initialStates[0]?.top.unplacedPieces).toEqual([])
    expect(result.placements.map((placement) => placement.pieceId)).toEqual(['a', 'b'])
    expect(result.unplacedPieceIds).toEqual([])
  })

  it('subtracts a committed placement from every overlapping free rectangle', () => {
    const selected = freeRectangleAt(0, 0, 100, 100)
    const overlapping = freeRectangleAt(0, 0, 50, 100)
    const candidate = new NestingAlgorithmCandidate({
      state: beamState({
        freeRectangles: [selected, overlapping],
        remainingPieces: [sizedPiece('a', 50, 50)]
      }),
      piece: sizedPiece('a', 50, 50),
      freeRectangle: selected,
      rotated: false,
      placement: placementAt(0, 0, 50, 50, 'a'),
      candidateOrderId: 'test-strategy'
    })

    const applied = applyCandidate(candidate)

    expect(applied.split.pruned.map((fr) => fr.id)).toEqual([overlapping.id])
    expect(
      applied.state.freeRectangles.every(
        (freeRectangle) => !FreeRectangles.intersects(freeRectangle, candidate.placement)
      )
    ).toBe(true)
  })

  it('deduplicates candidates selected by multiple placement orders', () => {
    const events: NestingAlgorithmEvent[] = []

    runMaxRectsBeamSearch({
      sheet: baseRequest().sheet,
      pieces: [piece('a'), piece('b')],
      beamWidth: K(2),
      candidateOrder: [
        new CandidateOrderEntry({ strategyId: 's1', order: Order.make(() => 0) }),
        new CandidateOrderEntry({ strategyId: 's2', order: Order.make(() => 0) })
      ],
      stateOrder: () => Order.make(() => 0),
      hooks: {
        onEvent: (event) => events.push(event)
      }
    })

    const beamStepEvent = events.find((event) => event.type === 'beam_step')
    expect(beamStepEvent?.candidateCount).toBe(16)
    expect(events.filter((event) => event.type === 'placement_applied')).toHaveLength(8)
    expect(events.filter((event) => event.type === 'state_selected')).toHaveLength(K(2))
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

describe('strategyOrders', () => {
  it('uses candidate prefix criteria before tail criteria', () => {
    const strategy = requireDefined(findStrategy('balanced-bottom-left-then-preserve-free'))
    const layoutStrategy = requireDefined(findLayoutSelectionStrategy('compact-first'))
    const order = makeStrategyOrders(baseRequest().sheet, [strategy], layoutStrategy)
      .candidateOrder[0]!.order
    const higherButCompact = candidateAt({
      freeRectangle: freeRectangleAt(10, 10, 10, 10),
      piece: sizedPiece('a', 10, 10)
    })
    const lowerButLargerCluster = candidateAt({
      freeRectangle: freeRectangleAt(0, 0, 80, 10),
      piece: sizedPiece('b', 80, 10)
    })

    expect(order(higherButCompact, lowerButLargerCluster)).toBeLessThan(0)
  })

  it('uses tail order to choose between prefix-tied candidates', () => {
    const preserveFree = requireDefined(findStrategy('balanced-preserve-free-then-bottom-left'))
    const bottomLeft = requireDefined(findStrategy('balanced-bottom-left-then-preserve-free'))
    const layoutStrategy = requireDefined(findLayoutSelectionStrategy('compact-first'))
    const preserveFreeOrder = makeStrategyOrders(baseRequest().sheet, [preserveFree], layoutStrategy)
      .candidateOrder[0]!.order
    const bottomLeftOrder = makeStrategyOrders(baseRequest().sheet, [bottomLeft], layoutStrategy)
      .candidateOrder[0]!.order
    const tightButHigher = candidateAt({
      freeRectangle: freeRectangleAt(0, 10, 10, 10),
      piece: sizedPiece('a', 10, 10)
    })
    const lowerButWasteful = candidateAt({
      freeRectangle: freeRectangleAt(10, 0, 100, 100),
      piece: sizedPiece('b', 10, 10)
    })

    expect(preserveFreeOrder(tightButHigher, lowerButWasteful)).toBeLessThan(0)
    expect(bottomLeftOrder(lowerButWasteful, tightButHigher)).toBeLessThan(0)
  })

  it('does not invent a short-side fill direction on square sheets', () => {
    const shortFill = requireDefined(findStrategy('short-fill-preserve-free-then-bottom-left'))
    const layoutStrategy = requireDefined(findLayoutSelectionStrategy('compact-first'))
    const squareSheet = { width: 100, height: 100, label: 'square' }
    const order = makeStrategyOrders(squareSheet, [shortFill], layoutStrategy)
      .candidateOrder[0]!.order
    const freeRectangle = freeRectangleAt(0, 0, 100, 100)
    const vertical = candidateAt({
      freeRectangle,
      piece: sizedPiece('vertical', 10, 50)
    })
    const horizontal = candidateAt({
      freeRectangle,
      piece: sizedPiece('horizontal', 50, 10)
    })

    expect(order(vertical, horizontal)).toBe(0)
  })

  it('prefers blockier balanced candidates over slightly smaller skinny clusters', () => {
    const balanced = requireDefined(findStrategy('balanced-bottom-left-then-preserve-free'))
    const layoutStrategy = requireDefined(findLayoutSelectionStrategy('compact-first'))
    const sheet = { width: 5000, height: 10000, label: 'tall' }
    const order = makeStrategyOrders(sheet, [balanced], layoutStrategy).candidateOrder[0]!.order
    const freeRectangle = freeRectangleAt(0, 0, sheet.width, sheet.height)
    const skinnySmallerArea = candidateAt({
      freeRectangle,
      piece: sizedPiece('skinny', 760, 3290)
    })
    const blockierLargerArea = candidateAt({
      freeRectangle,
      piece: sizedPiece('blockier', 1270, 1980)
    })

    expect(order(blockierLargerArea, skinnySmallerArea)).toBeLessThan(0)
  })

  it('fills the short sheet direction before area in short-fill candidate order', () => {
    const shortFill = requireDefined(findStrategy('short-fill-preserve-free-then-bottom-left'))
    const layoutStrategy = requireDefined(findLayoutSelectionStrategy('compact-first'))
    const sheet = { width: 5000, height: 10000, label: 'tall' }
    const order = makeStrategyOrders(sheet, [shortFill], layoutStrategy).candidateOrder[0]!.order
    const freeRectangle = freeRectangleAt(0, 0, sheet.width, sheet.height)
    const wider = candidateAt({
      freeRectangle,
      piece: sizedPiece('wider', 1980, 1010)
    })
    const taller = candidateAt({
      freeRectangle,
      piece: sizedPiece('taller', 1010, 1980)
    })

    expect(order(wider, taller)).toBeLessThan(0)
  })

  it('uses the selected layout metric to order beam states', () => {
    const compactFirst = requireDefined(findLayoutSelectionStrategy('compact-first'))
    const largestFreeAreaFirst = requireDefined(
      findLayoutSelectionStrategy('largest-free-area-first')
    )
    const compactOrder = makeStrategyOrders(baseRequest().sheet, [], compactFirst).stateOrder()
    const largestFreeAreaOrder = makeStrategyOrders(
      baseRequest().sheet,
      [],
      largestFreeAreaFirst
    ).stateOrder()
    const compactState = beamState({
      placements: [placementAt(0, 0, 10, 10, 'a')],
      freeRectangles: [freeRectangleAt(20, 0, 5, 10)]
    })
    const roomierState = beamState({
      placements: [placementAt(0, 0, 20, 10, 'b')],
      freeRectangles: [freeRectangleAt(30, 0, 40, 40)]
    })

    expect(compactOrder(compactState, roomierState)).toBeLessThan(0)
    expect(largestFreeAreaOrder(roomierState, compactState)).toBeLessThan(0)
  })

  it('prefers blockier survivor states over slightly smaller skinny clusters', () => {
    const compactFirst = requireDefined(findLayoutSelectionStrategy('compact-first'))
    const sheet = { width: 5000, height: 10000, label: 'tall' }
    const order = makeStrategyOrders(sheet, [], compactFirst).stateOrder()
    const skinnySmallerArea = beamState({
      placements: [placementAt(0, 0, 760, 3290, 'skinny')]
    })
    const blockierLargerArea = beamState({
      placements: [placementAt(0, 0, 1270, 1980, 'blockier')]
    })

    expect(order(blockierLargerArea, skinnySmallerArea)).toBeLessThan(0)
  })

  it('keeps states with fewer unplaced pieces ahead of compact failed states', () => {
    const compactFirst = requireDefined(findLayoutSelectionStrategy('compact-first'))
    const order = makeStrategyOrders(baseRequest().sheet, [], compactFirst).stateOrder()
    const placedState = beamState({
      placements: [placementAt(0, 0, 20, 20, 'a')],
      unplacedPieces: []
    })
    const failedState = beamState({
      placements: [],
      unplacedPieces: [piece('b')]
    })

    expect(order(placedState, failedState)).toBeLessThan(0)
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

describe('computeNesting', () => {
  it('returns an ok result when the selected beam places every piece', () => {
    const result = runNesting(baseRequest())
    expect(result.status).toBe('ok')
  })

  it('returns placements from the selected beam at every result level', () => {
    const result = runNesting(baseRequest())
    expect(result.placements.map((placement) => placement.pieceId)).toEqual(['a', 'b'])
    expect(result.strategyResults[0]?.placements.map((placement) => placement.pieceId)).toEqual([
      'a',
      'b'
    ])
  })

  it('preserves input order in sortedPieceIds at the top level', () => {
    const result = runNesting(baseRequest())
    expect(result.sortedPieceIds).toEqual(['a', 'b'])
  })

  it('returns only pieces the selected beam could not place', () => {
    const result = runNesting(baseRequest())
    expect(result.unplacedPieceIds).toEqual([])
  })

  it('uses requested strategy ids as candidate orders inside one beam run', () => {
    const req = baseRequest({
      options: options({
        strategySelectionMode: 'single',
        strategyIds: [
          'balanced-preserve-free-then-bottom-left',
          'short-fill-short-side-fit-then-bottom-left'
        ]
      })
    })
    const result = runNesting(req)
    expect(result.strategyResults).toHaveLength(1)
    expect(result.strategyResults[0]?.strategyId).toBe('maxrects-beam-search')
    expect(result.strategyResults[0]?.strategyDescription).toContain(
      'balanced-preserve-free-then-bottom-left'
    )
    expect(result.strategyResults[0]?.strategyDescription).toContain(
      'short-fill-short-side-fit-then-bottom-left'
    )
  })

  it('uses all configured strategies as candidate orders when requested', () => {
    const req = baseRequest({
      options: options({ strategySelectionMode: 'all_configured', strategyIds: [] })
    })
    const result = runNesting(req)
    const firstConfigured = STRATEGY_DEFINITIONS[0]
    const lastConfigured = STRATEGY_DEFINITIONS.at(-1)
    expect(result.strategyResults).toHaveLength(1)
    expect(firstConfigured).toBeDefined()
    expect(lastConfigured).toBeDefined()
    expect(result.strategyResults[0]?.strategyDescription).toContain(firstConfigured?.id)
    expect(result.strategyResults[0]?.strategyDescription).toContain(lastConfigured?.id)
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
    const result = runNesting(req)
    expect(result.selectedStrategyRunId).toBe(result.strategyResults[0]?.strategyRunId)
  })

  it('returns no implementation-placeholder warnings', () => {
    const result = runNesting(baseRequest())
    expect(result.warnings).toEqual([])
    for (const strategy of result.strategyResults) {
      expect(strategy.warnings).toEqual([])
    }
  })

  it('does not produce any fake history, beam, or split events', () => {
    const result = runNesting(baseRequest())
    expect(result.historySummary).toBeUndefined()
    for (const strategy of result.strategyResults) {
      expect(strategy.historySummary).toBeUndefined()
    }
  })

  it('emits initial and selected beam states from the wrapper layer', () => {
    const frames: NestingHistoryFrame[] = []
    const req = baseRequest({
      options: options({
        strategyIds: [
          'balanced-preserve-free-then-bottom-left',
          'short-fill-short-side-fit-then-bottom-left'
        ]
      })
    })

    computeNesting(req, {
      emitFrame: (frame) => {
        frames.push(frame)
      }
    })

    const initialFrames = frames.filter((frame) => frame.stepIndex === 0)
    const selectedFrames = frames.filter((frame) => frame.stepIndex > 0)

    expect(initialFrames).toHaveLength(4)
    expect(selectedFrames.length).toBeGreaterThan(0)
    expect(frames.every((frame) => frame.strategyRunId === 'run-1-maxrects-beam-search')).toBe(true)
    expect(initialFrames.map((frame) => frame.beamRank)).toEqual([0, 1, 2, 3])
    expect(initialFrames.every((frame) => frame.plate.placements.length === 1)).toBe(true)
    expect(initialFrames.every((frame) => frame.plate.freeRectangles.length === 2)).toBe(true)
    expect(selectedFrames.every((frame) => frame.beam !== undefined)).toBe(true)
    expect(frames[0]?.state.remainingPieceIds).toEqual(['b'])
    expect(frames[0]?.state.unplacedPieceIds).toEqual([])
  })

  it('records elapsed time and piece count in stats', () => {
    const result = runNesting(baseRequest())
    expect(result.stats.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.stats.algorithm.elapsedMs).toBe(result.stats.elapsedMs)
    expect(result.stats.pieceCount).toBe(2)
  })
})

describe('strategies data', () => {
  it('keeps all eight strategy definitions available for explicit lookup', () => {
    expect(ALL_STRATEGY_DEFINITIONS.length).toBe(8)
  })

  it('exposes the four dominant strategy definitions by default', () => {
    expect(
      STRATEGY_DEFINITIONS.map((strategy) => ({
        id: strategy.id,
        prefix: strategy.prefix,
        tail: strategy.tail
      }))
    ).toEqual([
      {
        id: 'balanced-preserve-free-then-bottom-left',
        prefix: 'balanced_compactness',
        tail: ['r', 's', 'y', 'x']
      },
      {
        id: 'short-fill-preserve-free-then-bottom-left',
        prefix: 'short_side_fill',
        tail: ['r', 's', 'y', 'x']
      },
      {
        id: 'balanced-bottom-left-then-short-side-fit',
        prefix: 'balanced_compactness',
        tail: ['y', 'x', 's', 'r']
      },
      {
        id: 'balanced-short-side-fit-then-bottom-left',
        prefix: 'balanced_compactness',
        tail: ['s', 'r', 'y', 'x']
      }
    ])
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

describe('layout selection strategy data', () => {
  it('registers the three layout selection definitions', () => {
    expect(LAYOUT_SELECTION_STRATEGIES.map((s) => s.id)).toEqual([
      'compact-first',
      'largest-free-area-first',
      'widest-usable-free-rectangle-first'
    ])
  })

  it('findLayoutSelectionStrategy returns the matching definition', () => {
    const def = findLayoutSelectionStrategy('largest-free-area-first')
    expect(def?.label).toContain('Largest free area')
  })
})

function makeStrategy(runId: string, strategyId: string): NestingStrategyResult {
  return {
    strategyRunId: runId,
    strategyId,
    strategyLabel: strategyId,
    status: 'completed',
    sortedPieceIds: ['a' as PieceId],
    placements: [placementAt(0, 0, 10, 10, 'a')],
    unplacedPieceIds: [],
    warnings: [],
    stats: {
      elapsedMs: 0,
      pieceCount: 1,
      algorithm: {
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:00.000Z',
        elapsedMs: 0
      }
    }
  }
}

function beamState(input: {
  readonly placements?: ReadonlyArray<Placement>
  readonly freeRectangles?: ReadonlyArray<FreeRectangle>
  readonly remainingPieces?: ReadonlyArray<PreparedPiece>
  readonly unplacedPieces?: ReadonlyArray<PreparedPiece>
}): NestingBeamState {
  return new NestingBeamState({
    placements: input.placements ?? [],
    freeRectangles: input.freeRectangles ?? [],
    remainingPieces: input.remainingPieces ?? [],
    unplacedPieces: input.unplacedPieces ?? []
  })
}

function candidateAt(input: {
  readonly freeRectangle: FreeRectangle
  readonly piece: PreparedPiece
  readonly candidateOrderId?: string
}): NestingAlgorithmCandidate {
  return new NestingAlgorithmCandidate({
    state: beamState({ freeRectangles: [input.freeRectangle] }),
    piece: input.piece,
    freeRectangle: input.freeRectangle,
    rotated: false,
    placement: makeBottomLeftPlacement(input.freeRectangle, input.piece, false),
    candidateOrderId: input.candidateOrderId ?? 'test-strategy'
  })
}

function freeRectangleAt(x: number, y: number, width: number, height: number): FreeRectangle {
  return new FreeRectangle({ x, y, width, height })
}

function placementAt(
  x: number,
  y: number,
  width: number,
  height: number,
  pieceId: string
): Placement {
  return {
    pieceId: pieceId as PieceId,
    x,
    y,
    width,
    height,
    rotation: 0
  }
}

function requireDefined<T>(value: T | undefined): T {
  expect(value).toBeDefined()
  if (value === undefined) {
    throw new Error('Expected test fixture to resolve')
  }
  return value
}
