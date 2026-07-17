import { describe, expect, it } from 'vitest'
import { canonicalizeIrregularLayout } from '../../scripts/lib/irregularLayoutCanonicalization.js'

const layout = [
  [
    { x: 10, y: 20 },
    { x: 40, y: 20 },
    { x: 10, y: 50 }
  ],
  [
    { x: 40, y: 20 },
    { x: 70, y: 50 },
    { x: 40, y: 50 }
  ]
]

describe('irregular layout canonicalization', () => {
  it('ignores rigid translation, quarter-turn, copy order, winding, and ring origin', () => {
    const transformed = [...layout]
      .reverse()
      .map((polygon) => [...polygon].reverse().map(({ x, y }) => ({ x: 200 - y, y: x + 300 })))
      .map((polygon) => [...polygon.slice(1), ...polygon.slice(0, 1)])

    expect(canonicalizeIrregularLayout(transformed).sha256).toBe(
      canonicalizeIrregularLayout(layout).sha256
    )
  })

  it('detects geometry that is not related by an allowed rigid transform', () => {
    const changed = layout.map((polygon, polygonIndex) =>
      polygon.map((point, pointIndex) =>
        polygonIndex === 1 && pointIndex === 1 ? { ...point, x: point.x + 1 } : point
      )
    )

    expect(canonicalizeIrregularLayout(changed).sha256).not.toBe(
      canonicalizeIrregularLayout(layout).sha256
    )
  })

  it('uses the collision grid to ignore sub-grid coordinate noise', () => {
    const noisy = layout.map((polygon) =>
      polygon.map(({ x, y }) => ({ x: x + 0.000_1, y: y - 0.000_1 }))
    )

    expect(canonicalizeIrregularLayout(noisy).sha256).toBe(
      canonicalizeIrregularLayout(layout).sha256
    )
  })
})
