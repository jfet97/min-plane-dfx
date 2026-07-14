import { describe, expect, it } from 'vitest'
import { IrregularPoint } from '@shared/irregular/domain.js'
import { ConvexPolygonValidation } from '../../src/workers/irregular/convexPolygonValidation.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

describe('ConvexPolygonValidation', () => {
  it('accepts strict convex rings in either winding', () => {
    const counterClockwise = [point(0, 0), point(4, 0), point(4, 3), point(0, 3)]
    const clockwise = [...counterClockwise].reverse()

    expect(ConvexPolygonValidation.validateStrictBoundary(counterClockwise)).toEqual({
      winding: 1
    })
    expect(ConvexPolygonValidation.validateStrictBoundary(clockwise)).toEqual({ winding: -1 })
  })

  it('rejects a pentagram whose local turns all agree', () => {
    const pentagram = [point(0, 4), point(2, -3), point(-4, 1), point(4, 1), point(-2, -3)]

    expect(ConvexPolygonValidation.validateStrictBoundary(pentagram)).toEqual({
      message: 'polygon must form a simple ring without self-intersections.'
    })
  })

  it('rejects a non-adjacent edge crossing', () => {
    const bowTie = [point(0, 0), point(4, 4), point(0, 4), point(4, 0)]

    expect(ConvexPolygonValidation.validateStrictBoundary(bowTie)).toEqual({
      message: 'polygon must form a simple ring without self-intersections.'
    })
  })

  it('rejects a non-adjacent boundary touch', () => {
    const touchingRing = [point(0, 0), point(4, 0), point(4, 4), point(0, 4), point(2, 0)]

    expect(ConvexPolygonValidation.validateStrictBoundary(touchingRing)).toEqual({
      message: 'polygon must form a simple ring without self-intersections.'
    })
  })

  it('keeps rejecting a simple concave ring', () => {
    const concave = [point(0, 0), point(4, 0), point(2, 1), point(4, 4), point(0, 4)]

    expect(ConvexPolygonValidation.validateStrictBoundary(concave)).toEqual({
      message: 'polygon must be strictly convex with one consistent winding.'
    })
  })
})
