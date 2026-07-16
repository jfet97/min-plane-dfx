import { describe, expect, it } from 'vitest'
import { IrregularBounds, IrregularPoint, IrregularPolygon } from '@shared/irregular/domain.js'
import {
  areDisjoint,
  boundsForPoints,
  translatePolygonWithBounds
} from '../../src/workers/irregular/convexBounds.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

describe('convex bounds', () => {
  it('uses strict separation so touching bounds survive the broad phase', () => {
    const first = new IrregularBounds({ minX: 0, minY: 0, maxX: 2, maxY: 2 })
    const touching = new IrregularBounds({ minX: 2, minY: 0, maxX: 4, maxY: 2 })
    const overlapping = new IrregularBounds({ minX: 1, minY: 0, maxX: 4, maxY: 2 })
    const disjoint = new IrregularBounds({ minX: 2.1, minY: 0, maxX: 4, maxY: 2 })

    expect(areDisjoint(first, touching)).toBe(false)
    expect(areDisjoint(first, overlapping)).toBe(false)
    expect(areDisjoint(first, disjoint)).toBe(true)
  })

  it('carries translated polygon bounds from the same coordinate pass', () => {
    const translated = translatePolygonWithBounds(
      new IrregularPolygon({ points: [point(-1, 2), point(3, 0), point(2, 4)] }),
      point(5, -2)
    )

    expect(translated).toEqual({
      polygon: new IrregularPolygon({ points: [point(4, 0), point(8, -2), point(7, 2)] }),
      bounds: new IrregularBounds({ minX: 4, minY: -2, maxX: 8, maxY: 2 })
    })
    expect(boundsForPoints(translated?.polygon.points ?? [])).toEqual(translated?.bounds)
  })
})
