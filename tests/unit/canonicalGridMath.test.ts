import { describe, expect, it } from 'vitest'
import type { Path64 } from 'clipper2-ts'
import {
  CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT,
  canonicalGridAbsoluteDoubledArea,
  canonicalGridConvexHull,
  canonicalGridCross,
  canonicalGridCrossSign,
  compareCanonicalGridRatios,
  type CanonicalGridPoint
} from '../../src/workers/irregular/canonicalGridMath.js'

/** Sign of the exact bigint cross product, the oracle the fast path must match. */
function exactCrossSign(
  origin: CanonicalGridPoint,
  first: CanonicalGridPoint,
  second: CanonicalGridPoint
): -1 | 0 | 1 | undefined {
  const exact = canonicalGridCross(origin, first, second)
  if (exact === undefined) return undefined
  return exact === 0n ? 0 : exact < 0n ? -1 : 1
}

/** Deterministic pseudo-random integers; no Math.random so failures reproduce. */
function makeSequence(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state
  }
}

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

describe('canonical grid cross sign', () => {
  it('matches the exact bigint oracle across the fast path, the boundary, and the fallback', () => {
    const limit = CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT
    const next = makeSequence(0x5eed)
    const magnitudes = [
      1,
      1_000,
      2_700_000,
      limit - 1,
      limit,
      limit + 1,
      2 ** 31,
      900_000_000,
      Number.MAX_SAFE_INTEGER
    ]
    let compared = 0
    for (const magnitude of magnitudes) {
      for (let trial = 0; trial < 400; trial += 1) {
        const coordinate = (): number => {
          const span = 2 * magnitude + 1
          const value = (next() % span) - magnitude
          return Number.isSafeInteger(value) ? value : magnitude
        }
        const origin = { x: coordinate(), y: coordinate() }
        const first = { x: coordinate(), y: coordinate() }
        const second = { x: coordinate(), y: coordinate() }
        expect(canonicalGridCrossSign(origin, first, second)).toBe(
          exactCrossSign(origin, first, second)
        )
        compared += 1
      }
    }
    expect(compared).toBe(magnitudes.length * 400)
  })

  it('agrees with the oracle on collinear, degenerate, and signed-zero inputs', () => {
    const cases: ReadonlyArray<readonly [CanonicalGridPoint, CanonicalGridPoint, CanonicalGridPoint]> = [
      [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 5 }],
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }],
      [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
      [{ x: -0, y: -0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }],
      [{ x: -5, y: -5 }, { x: -1, y: -5 }, { x: -3, y: -5 }],
      [
        { x: CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT, y: CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT },
        { x: -CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT, y: CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT },
        { x: 0, y: -CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT }
      ]
    ]
    for (const [origin, first, second] of cases) {
      expect(canonicalGridCrossSign(origin, first, second)).toBe(
        exactCrossSign(origin, first, second)
      )
    }
  })

  it('detects a one-unit orientation difference at the extreme of the fast path', () => {
    // the whole point of the bound: nothing may round, so a single grid unit
    // still flips the orientation at the largest admitted magnitude
    const limit = CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT
    const origin = { x: -limit, y: -limit }
    const first = { x: limit, y: limit }
    expect(canonicalGridCrossSign(origin, first, { x: limit, y: limit - 1 })).toBe(-1)
    expect(canonicalGridCrossSign(origin, first, { x: limit, y: limit })).toBe(0)
    expect(canonicalGridCrossSign(origin, first, { x: limit - 1, y: limit })).toBe(1)
  })

  it('matches the exact fallback at both signs of its boundary and the safe-integer extremes', () => {
    const limit = CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT
    const outside = limit + 1
    const maximum = Number.MAX_SAFE_INTEGER
    const cases: ReadonlyArray<
      readonly [CanonicalGridPoint, CanonicalGridPoint, CanonicalGridPoint]
    > = [
      [{ x: -outside, y: 0 }, { x: outside, y: 1 }, { x: outside, y: 0 }],
      [{ x: outside, y: 0 }, { x: -outside, y: -1 }, { x: -outside, y: 0 }],
      [{ x: -maximum, y: -maximum }, { x: maximum, y: -maximum }, { x: -maximum, y: maximum }],
      [{ x: maximum, y: maximum }, { x: -maximum, y: maximum }, { x: maximum, y: -maximum }],
      [{ x: -maximum, y: -maximum }, { x: 0, y: 0 }, { x: maximum, y: maximum }]
    ]
    for (const [origin, first, second] of cases) {
      expect(canonicalGridCrossSign(origin, first, second)).toBe(
        exactCrossSign(origin, first, second)
      )
    }
  })

  it('rejects coordinates the canonical grid cannot represent', () => {
    const valid = { x: 1, y: 1 }
    expect(canonicalGridCrossSign({ x: Number.NaN, y: 0 }, valid, valid)).toBeUndefined()
    expect(canonicalGridCrossSign({ x: 0.5, y: 0 }, valid, valid)).toBeUndefined()
    expect(
      canonicalGridCrossSign({ x: Number.POSITIVE_INFINITY, y: 0 }, valid, valid)
    ).toBeUndefined()
    expect(
      canonicalGridCrossSign({ x: Number.MAX_SAFE_INTEGER + 1, y: 0 }, valid, valid)
    ).toBeUndefined()
  })
})
