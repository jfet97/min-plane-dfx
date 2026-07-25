import { describe, expect, it } from 'vitest'
import { PieceId } from '@shared/domain/ids.js'
import type { CanonicalLayoutStructuralAnalysis } from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import type { IntrinsicRelaxationMetrics } from '../../src/workers/algorithm/irregular/overlapRelaxation.js'
import {
  compareTargetedExactLnsFinalists,
  isAdmissibleTargetedImprovement,
  selectTargetedDestroySet
} from '../../src/workers/algorithm/irregular/targetedExactLns.js'

const id = (value: string) => PieceId.make(value)

function analysis(input: {
  readonly components: ReadonlyArray<ReadonlyArray<string>>
  readonly conflicts?: ReadonlyArray<readonly [string, string]>
  readonly wall?: ReadonlyArray<string>
}): CanonicalLayoutStructuralAnalysis {
  const ids = [...new Set(input.components.flat())]
  return {
    pieces: ids.map((pieceId, index) => ({
      pieceId: id(pieceId),
      aabb: {
        minX: index * 2_000,
        minY: 0,
        maxX: index * 2_000 + 1_000,
        maxY: 1_000
      },
      areaGrid2: 1_000_000,
      doubledAreaGrid2: '2000000'
    })),
    positiveContactComponents: input.components.map((component) => component.map(id)),
    positiveContactPairs: [],
    largestHullGap: {
      path: [],
      areaMm2: 1,
      aabb: { minX: 4_000, minY: 0, maxX: 5_000, maxY: 1_000 }
    },
    positiveAreaConflicts: (input.conflicts ?? []).map(([first, second]) => [
      id(first),
      id(second)
    ]),
    positiveAreaConflictMeasurements: (input.conflicts ?? []).map(([first, second]) => ({
      pair: [id(first), id(second)],
      areaMm2: 0.001
    })),
    wallOffenders: (input.wall ?? []).map(id)
  }
}

function metrics(overrides: Partial<IntrinsicRelaxationMetrics> = {}): IntrinsicRelaxationMetrics {
  return {
    width: 10,
    height: 10,
    maxSide: 10,
    area: 100,
    span: 20,
    topology: {
      enclosedCavityCount: 1,
      largestOccupiedHullGapRatio: 0.2,
      occupiedEnvelopeAspectRatio: 1,
      positiveContactComponentCount: 3,
      isolatedPieceCount: 2,
      largestPositiveContactComponentSize: 5,
      largestPositiveContactComponentRatio: 0.5
    },
    nearCompleteStructuralContactCount: 4,
    dominantNearCompleteStructuralContactCount: 2,
    sharedCollisionBoundaryContactUnits: 3,
    ...overrides
  }
}

describe('targeted exact LNS policy', () => {
  it('orders one-grid-square finalist differences above Number.MAX_SAFE_INTEGER exactly', () => {
    const smaller = metrics({
      area: 1_000_000_000_000_000_000,
      exact: {
        maximumSideGrid: 1_000_000_000,
        envelopeAreaGrid2: '999999999999999999',
        largestHullGapDoubledAreaGrid2: '0',
        hullDoubledAreaGrid2: '1'
      }
    })
    const larger = metrics({
      area: 1_000_000_000_000_000_000,
      exact: {
        maximumSideGrid: 1_000_000_000,
        envelopeAreaGrid2: '1000000000000000000',
        largestHullGapDoubledAreaGrid2: '0',
        hullDoubledAreaGrid2: '1'
      }
    })

    expect(
      compareTargetedExactLnsFinalists(
        { metrics: smaller, key: 'smaller' },
        { metrics: larger, key: 'larger' }
      )
    ).toBeLessThan(0)
  })

  it('selects only the nearest interface pair before filling a component larger than k', () => {
    const current = analysis({
      components: [
        ['p0', 'p1', 'p2', 'p3'],
        ['d0', 'd1', 'd2', 'd3', 'd4']
      ]
    })
    const ranks = new Map(current.pieces.map(({ pieceId }, index) => [pieceId, index]))

    const selected = selectTargetedDestroySet({
      target: 'interface',
      requestedK: 2,
      analysis: current,
      originalRankById: ranks
    })

    expect(selected.destroyIds).toHaveLength(2)
    expect(selected.mandatoryIds).toHaveLength(2)
    expect(selected.mandatoryIds.some((pieceId) => pieceId.startsWith('p'))).toBe(true)
    expect(selected.mandatoryIds.some((pieceId) => pieceId.startsWith('d'))).toBe(true)
  })

  it('allows the hazard destroy set to exceed the requested size', () => {
    const current = analysis({
      components: [['a'], ['b'], ['c'], ['d'], ['e']],
      conflicts: [
        ['a', 'b'],
        ['c', 'd']
      ],
      wall: ['e']
    })
    const ranks = new Map(current.pieces.map(({ pieceId }, index) => [pieceId, index]))

    const selected = selectTargetedDestroySet({
      target: 'v1_hazard',
      requestedK: 2,
      analysis: current,
      originalRankById: ranks
    })

    expect(selected.mandatoryIds).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(selected.destroyIds).toHaveLength(5)
  })

  it('adds exact legalization endpoints to non-hazard targets before freezing', () => {
    const current = analysis({
      components: [
        ['p0', 'p1'],
        ['d0', 'd1'],
        ['x0'],
        ['x1']
      ],
      conflicts: [['x0', 'x1']]
    })
    const ranks = new Map(current.pieces.map(({ pieceId }, index) => [pieceId, index]))

    const selected = selectTargetedDestroySet({
      target: 'interface',
      requestedK: 2,
      analysis: current,
      originalRankById: ranks
    })

    expect(selected.mandatoryIds).toContain('x0')
    expect(selected.mandatoryIds).toContain('x1')
    expect(selected.destroyIds.length).toBeGreaterThanOrEqual(4)
  })

  it('accepts a strict topology improvement and rolls back any guarded regression', () => {
    const incumbent = metrics()
    const better = metrics({
      topology: {
        ...incumbent.topology,
        positiveContactComponentCount: 2,
        isolatedPieceCount: 1,
        largestPositiveContactComponentSize: 6,
        largestPositiveContactComponentRatio: 0.6
      }
    })
    const regressed = metrics({
      area: 101,
      topology: better.topology
    })

    expect(isAdmissibleTargetedImprovement(incumbent, better)).toBe(true)
    expect(isAdmissibleTargetedImprovement(incumbent, regressed)).toBe(false)
  })
})
