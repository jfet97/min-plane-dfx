import { describe, expect, it } from 'vitest'
import { measureConvexSatPenetration } from '../../src/workers/irregular/convexSatPenetration.js'

const square = (x: number, y: number, size = 2) => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size }
]

describe('measureConvexSatPenetration', () => {
  it('returns no penetration for separation and exact boundary touch', () => {
    expect(measureConvexSatPenetration(square(0, 0), square(3, 0))).toBeUndefined()
    expect(measureConvexSatPenetration(square(0, 0), square(2, 0))).toBeUndefined()
  })

  it('returns the deterministic minimum translation for positive overlap', () => {
    expect(measureConvexSatPenetration(square(1.5, 0), square(0, 0))).toEqual({
      depth: 0.5,
      translation: { x: 0.5, y: 0 }
    })
  })

  it('uses an edge normal from either convex polygon', () => {
    const diamond = [
      { x: 1, y: -0.5 },
      { x: 2.5, y: 1 },
      { x: 1, y: 2.5 },
      { x: -0.5, y: 1 }
    ]
    const penetration = measureConvexSatPenetration(diamond, square(2, 0))
    expect(penetration).toBeDefined()
    expect(penetration?.depth).toBeGreaterThan(0)
    expect(Math.hypot(penetration?.translation.x ?? 0, penetration?.translation.y ?? 0)).toBeCloseTo(
      penetration?.depth ?? 0
    )
  })
})
