/**
 * Pins the canonical collision-polygon key against the implementation that
 * produced the accepted production identities.
 *
 * The reduced-allocation rewrite is only admissible if it emits the same bytes,
 * so the previous implementation is retained here verbatim as an oracle and
 * compared over a deterministic randomized corpus. A divergence here means a
 * layout identity changed.
 */
import { describe, expect, it } from 'vitest'

import { canonicalCollisionPolygonKey } from '../../src/workers/algorithm/irregular/irregularBeamState.js'
import { canonicalizeIrregularScoreMillimeterUnits } from '../../src/workers/algorithm/irregular/irregularScoreGrid.js'

type CanonicalPoint = readonly [x: number, y: number]

// ---- oracle: the implementation replaced by the reduced-allocation rewrite ----

function oracleCanonicalCollisionPolygonKey(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  translateX = 0,
  translateY = 0
): string {
  const canonicalPoints: CanonicalPoint[] = new Array(points.length)
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    if (point === undefined) continue
    canonicalPoints[index] = [
      oracleNormalizeCoordinate(point.x + translateX),
      oracleNormalizeCoordinate(point.y + translateY)
    ]
  }
  return oracleRecord([['polygon-ring', oracleRingKey(canonicalPoints)]])
}

function oracleSelectsReverse(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  translateX: number,
  translateY: number
): boolean {
  const canonicalPoints = points.map(
    (point) =>
      [
        oracleNormalizeCoordinate(point.x + translateX),
        oracleNormalizeCoordinate(point.y + translateY)
      ] as const
  )
  if (canonicalPoints.length === 0) return false
  const startIndex = oracleLowestYThenXIndex(canonicalPoints)
  return (
    oracleComparePointSequences(
      oracleRotatedRing(canonicalPoints, startIndex, 1),
      oracleRotatedRing(canonicalPoints, startIndex, -1)
    ) > 0
  )
}

function oracleRingKey(points: ReadonlyArray<CanonicalPoint>): string {
  if (points.length === 0) return oracleRecord([['point-count', '0']])

  const startIndex = oracleLowestYThenXIndex(points)
  const forward = oracleRotatedRing(points, startIndex, 1)
  const reverse = oracleRotatedRing(points, startIndex, -1)
  const canonicalPoints = oracleComparePointSequences(forward, reverse) <= 0 ? forward : reverse
  return oracleRecord([
    ['point-count', oracleNumber(canonicalPoints.length)],
    ...canonicalPoints.map((point, index) => [`point-${index}`, oraclePointKey(point)])
  ])
}

function oracleRotatedRing(
  points: ReadonlyArray<CanonicalPoint>,
  startIndex: number,
  direction: 1 | -1
): ReadonlyArray<CanonicalPoint> {
  const ring: CanonicalPoint[] = []
  for (let offset = 0; offset < points.length; offset += 1) {
    const pointIndex = (startIndex + direction * offset + points.length * 2) % points.length
    const point = points[pointIndex]
    if (point === undefined) return []
    ring.push(point)
  }
  return ring
}

function oracleLowestYThenXIndex(points: ReadonlyArray<CanonicalPoint>): number {
  let startIndex = 0
  for (let index = 1; index < points.length; index += 1) {
    const candidate = points[index]
    const current = points[startIndex]
    if (candidate === undefined || current === undefined) continue
    if (candidate[1] < current[1] || (candidate[1] === current[1] && candidate[0] < current[0])) {
      startIndex = index
    }
  }
  return startIndex
}

function oracleComparePointSequences(
  first: ReadonlyArray<CanonicalPoint>,
  second: ReadonlyArray<CanonicalPoint>
): number {
  const pointCountComparison = first.length - second.length
  if (pointCountComparison !== 0) return pointCountComparison

  for (let index = 0; index < first.length; index += 1) {
    const firstPoint = first[index]
    const secondPoint = second[index]
    if (firstPoint === undefined || secondPoint === undefined) {
      return firstPoint === undefined && secondPoint === undefined
        ? 0
        : firstPoint === undefined
          ? -1
          : 1
    }
    const firstKey = oraclePointKey(firstPoint)
    const secondKey = oraclePointKey(secondPoint)
    if (firstKey < secondKey) return -1
    if (firstKey > secondKey) return 1
  }
  return 0
}

function oraclePointKey(point: CanonicalPoint): string {
  return oracleRecord([
    ['x', oracleNumber(point[0])],
    ['y', oracleNumber(point[1])]
  ])
}

function oracleRecord(fields: ReadonlyArray<ReadonlyArray<string>>): string {
  return fields
    .map((field) => {
      const name = field[0]
      const value = field[1]
      if (name === undefined || value === undefined) return ''
      return `${oracleToken(name)}${oracleToken(value)}`
    })
    .join('')
}

function oracleToken(value: string): string {
  return `${value.length}:${value}`
}

function oracleNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (Object.is(value, -0)) return '0'
  if (value === Number.POSITIVE_INFINITY) return '+Infinity'
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
  return String(value)
}

function oracleNormalizeCoordinate(value: number): number {
  return canonicalizeIrregularScoreMillimeterUnits(value) ?? (Object.is(value, -0) ? 0 : value)
}

// ---- deterministic corpus ----

function makeRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

describe('canonicalCollisionPolygonKey', () => {
  it('matches the previous implementation across a randomized corpus', () => {
    const random = makeRandom(987654321)
    let comparisons = 0
    let reverseBranchRequired = 0

    for (let trial = 0; trial < 5000; trial += 1) {
      const vertexCount = 3 + Math.floor(random() * 38)
      const scale = trial % 3 === 0 ? 1000 : trial % 3 === 1 ? 1 : 0.001
      const points: { x: number; y: number }[] = []
      for (let index = 0; index < vertexCount; index += 1) {
        points.push({ x: (random() * 2 - 1) * scale, y: (random() * 2 - 1) * scale })
      }
      // repeated vertices and signed zero are both reachable from real geometry
      if (trial % 7 === 0) points[1] = { ...(points[0] as { x: number; y: number }) }
      if (trial % 11 === 0) points.push({ x: -0, y: 0 })

      const translateX = trial % 5 === 0 ? 0 : (random() * 2 - 1) * 500
      const translateY = trial % 5 === 0 ? 0 : (random() * 2 - 1) * 500

      const expected = oracleCanonicalCollisionPolygonKey(points, translateX, translateY)
      expect(canonicalCollisionPolygonKey(points, translateX, translateY)).toBe(expected)
      comparisons += 1

      // the independent oracle proves the corpus requires the reverse candidate
      if (oracleSelectsReverse(points, translateX, translateY)) {
        reverseBranchRequired += 1
      }
      const reversed = [...points].reverse()
      expect(canonicalCollisionPolygonKey(reversed, translateX, translateY)).toBe(
        oracleCanonicalCollisionPolygonKey(reversed, translateX, translateY)
      )
    }

    expect(comparisons).toBe(5000)
    expect(reverseBranchRequired).toBeGreaterThan(1000)
  })

  it('keeps start vertex and winding out of the emitted key', () => {
    const square = [
      { x: 10, y: 10 },
      { x: 30, y: 10 },
      { x: 30, y: 25 },
      { x: 10, y: 25 }
    ]
    const rotated = [square[1], square[2], square[3], square[0]] as typeof square
    const reversed = [...square].reverse()

    const expected = canonicalCollisionPolygonKey(square)
    expect(canonicalCollisionPolygonKey(rotated)).toBe(expected)
    expect(canonicalCollisionPolygonKey(reversed)).toBe(expected)
  })

  it('folds translation into the key rather than the caller', () => {
    const triangle = [
      { x: 0, y: 0 },
      { x: 12.5, y: 0 },
      { x: 6.25, y: 9 }
    ]
    const shifted = triangle.map((point) => ({ x: point.x + 41.5, y: point.y + 17.25 }))

    expect(canonicalCollisionPolygonKey(triangle, 41.5, 17.25)).toBe(
      canonicalCollisionPolygonKey(shifted)
    )
  })

  it('emits the empty-ring key for an empty boundary', () => {
    expect(canonicalCollisionPolygonKey([])).toBe(oracleCanonicalCollisionPolygonKey([]))
  })
})
