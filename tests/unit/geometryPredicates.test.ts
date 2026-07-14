import { describe, expect, it } from 'vitest'
import { GeometryPredicates } from '../../src/workers/irregular/geometryPredicates.js'
import { IrregularPoint } from '@shared/irregular/domain.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

describe('GeometryPredicates', () => {
  it('uses DXF y-up orientation semantics', () => {
    expect(GeometryPredicates.orientation(point(0, 0), point(1, 0), point(0, 1))).toBe(1)
    expect(GeometryPredicates.orientation(point(0, 0), point(0, 1), point(1, 0))).toBe(-1)
    expect(GeometryPredicates.orientation(point(0, 0), point(1, 1), point(2, 2))).toBe(0)
  })

  it('preserves a turn whose ordinary determinant rounds to zero', () => {
    const epsilon = Number.EPSILON
    const origin = point(0, 0)
    const first = point(1 + epsilon, 1)
    const second = point(1, 1 - epsilon)
    const ordinaryDeterminant =
      (first.x - origin.x) * (second.y - origin.y) -
      (first.y - origin.y) * (second.x - origin.x)

    expect(ordinaryDeterminant).toBe(0)
    expect(GeometryPredicates.orientation(origin, first, second)).toBe(-1)
  })
})
