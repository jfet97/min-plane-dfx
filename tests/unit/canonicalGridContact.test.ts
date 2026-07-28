import type { Path64 } from 'clipper2-ts'
import { describe, expect, it } from 'vitest'
import { measureCanonicalGridBoundaryOverlapAxisUnits } from '../../src/workers/irregular/canonicalGridContact.js'

const horizontalFirst: Path64 = [
  { x: 0, y: 0 },
  { x: 1_000, y: 0 },
  { x: 0, y: 1_000 }
]

const horizontalSecond: Path64 = [
  { x: 1_000, y: 0 },
  { x: 0, y: 0 },
  { x: 1_000, y: -1_000 }
]

const diagonalFirst: Path64 = [
  { x: 0, y: 0 },
  { x: 800, y: 800 },
  { x: 0, y: 1_600 }
]

const diagonalSecond: Path64 = [
  { x: 800, y: 800 },
  { x: 0, y: 0 },
  { x: 1_600, y: 0 }
]

const octagonFirst: Path64 = [
  { x: 0, y: 0 },
  { x: 1_000, y: 0 },
  { x: 2_000, y: 1_000 },
  { x: 2_000, y: 2_000 },
  { x: 1_000, y: 3_000 },
  { x: 0, y: 3_000 },
  { x: -1_000, y: 2_000 },
  { x: -1_000, y: 1_000 }
]

const octagonSecond: Path64 = octagonFirst.map(({ x, y }) => ({
  x: x + 10_000,
  y
}))

describe('canonical grid contact overlap axis units', () => {
  it('measures an axis-aligned positive contact exactly', () => {
    expect(
      measureCanonicalGridBoundaryOverlapAxisUnits(horizontalFirst, horizontalSecond)
    ).toEqual({ kind: 'measured', score: 1_000n })
  })

  it('preserves the historical caller decision for positive diagonal contact', () => {
    expect(measureCanonicalGridBoundaryOverlapAxisUnits(diagonalFirst, diagonalSecond)).toEqual({
      kind: 'undecidable'
    })
  })

  it('aborts inside the edge-pair scan when a deadline checkpoint expires', () => {
    let checks = 0
    const pathConstructionChecks = octagonFirst.length + octagonSecond.length
    const result = measureCanonicalGridBoundaryOverlapAxisUnits(
      octagonFirst,
      octagonSecond,
      () => {
        checks += 1
        return checks <= pathConstructionChecks + 5
      }
    )

    expect(checks).toBeGreaterThan(pathConstructionChecks)
    expect(result).toEqual({ kind: 'aborted' })
  })

  it('aborts inside the edge-pair scan when an RSS checkpoint expires', () => {
    let sampledRssBytes = 0
    const pathConstructionChecks = octagonFirst.length + octagonSecond.length
    const result = measureCanonicalGridBoundaryOverlapAxisUnits(
      octagonFirst,
      octagonSecond,
      () => {
        sampledRssBytes += 1
        return sampledRssBytes <= pathConstructionChecks + 3
      }
    )

    expect(sampledRssBytes).toBeGreaterThan(pathConstructionChecks)
    expect(result).toEqual({ kind: 'aborted' })
  })
})
