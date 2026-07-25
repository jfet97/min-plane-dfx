import { describe, expect, it } from 'vitest'
import type { Path64 } from 'clipper2-ts'
import {
  canonicalGridAbsoluteDoubledArea,
  canonicalGridConvexHull,
  compareCanonicalGridRatios
} from '../../src/workers/irregular/canonicalGridMath.js'

function translate(path: Path64, x: number, y: number): Path64 {
  return path.map((point) => ({ x: point.x + x, y: point.y + y }))
}

describe('canonical grid exact arithmetic', () => {
  it('preserves a one-grid-square area difference near the coordinate policy limit', () => {
    const origin = 999_999_000
    const smaller: Path64 = [
      { x: origin, y: origin },
      { x: origin + 999, y: origin },
      { x: origin + 999, y: origin + 1 },
      { x: origin, y: origin + 1 }
    ]
    const larger: Path64 = [
      { x: origin, y: origin },
      { x: origin + 1_000, y: origin },
      { x: origin + 1_000, y: origin + 1 },
      { x: origin, y: origin + 1 }
    ]

    expect(canonicalGridAbsoluteDoubledArea(larger)).toBe(
      (canonicalGridAbsoluteDoubledArea(smaller) ?? 0n) + 2n
    )
  })

  it('keeps hull area and rational ordering invariant under large-grid translation', () => {
    const points: Path64 = [
      { x: 0, y: 0 },
      { x: 7, y: 0 },
      { x: 3, y: 2 },
      { x: 7, y: 5 },
      { x: 0, y: 5 }
    ]
    const translated = translate(points, 900_000_000, -900_000_000)
    const hull = canonicalGridConvexHull(points)
    const translatedHull = canonicalGridConvexHull(translated)
    const area = hull === undefined ? undefined : canonicalGridAbsoluteDoubledArea(hull)
    const translatedArea =
      translatedHull === undefined
        ? undefined
        : canonicalGridAbsoluteDoubledArea(translatedHull)

    expect(translatedArea).toBe(area)
    expect(compareCanonicalGridRatios(1n, 3n, 2n, 6n)).toBe(0)
    expect(compareCanonicalGridRatios(1n, 3n, 2n, 5n)).toBeLessThan(0)
  })
})
