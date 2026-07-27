/**
 * Covers the two trust shortcuts on the warm pairwise NFP path: validating each
 * cache-stable input ring once per array identity, and accepting a relative
 * boundary this process stored without walking it again.
 *
 * Both are admissible only while foreign and malformed values keep taking the
 * full check, so that is what these cases pin.
 */
import { describe, expect, it } from 'vitest'
import {
  isValidCachedNfpBoundary,
  resolveNfpBoundary,
  type CoreNfpInput
} from '../../src/workers/irregular/core/nfpBoundaryCore.js'
import type {
  GeometryCacheKey,
  GeometryCacheStore
} from '../../src/workers/irregular/core/geometryCacheStore.js'
import { serializeGeometryCacheKey } from '../../src/workers/irregular/core/geometryCacheStore.js'

const settings = {
  flatteningSagToleranceMm: 0.05,
  clearanceSafetyMarginMm: 0.05,
  geometryBackendId: 'clipper2-ts',
  geometryBackendVersion: '2.0.1-18'
} as const

const transform = {
  index: 0,
  rotationDeg: 0,
  mirrored: false,
  reason: 'configured'
} as const

function makeStore(): GeometryCacheStore {
  const entries = new Map<string, unknown>()
  return {
    get: <A>(key: GeometryCacheKey) => entries.get(serializeGeometryCacheKey(key)) as A | undefined,
    set: <A>(key: GeometryCacheKey, value: A) => {
      entries.set(serializeGeometryCacheKey(key), value)
    },
    remove: (key: GeometryCacheKey) => {
      entries.delete(serializeGeometryCacheKey(key))
    },
    clear: () => {
      entries.clear()
    }
  }
}

function makeInput(
  fixedPoints: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  movingPoints: ReadonlyArray<{ readonly x: number; readonly y: number }>
): CoreNfpInput {
  return {
    fixed: {
      collisionGeometry: { polygon: { points: fixedPoints }, transform },
      placement: { transform: { translateX: 3.5, translateY: 1.25 } }
    },
    moving: { polygon: { points: movingPoints }, transform },
    settings
  }
}

const square = [
  { x: 0, y: 0 },
  { x: 0, y: 4 },
  { x: 4, y: 4 },
  { x: 4, y: 0 }
]
const smallSquare = [
  { x: 0, y: 0 },
  { x: 0, y: 2 },
  { x: 2, y: 2 },
  { x: 2, y: 0 }
]

describe('trusted ring shortcuts on the pairwise NFP path', () => {
  it('returns the same boundary on repeated resolutions of one input identity', () => {
    const store = makeStore()
    const input = makeInput(square, smallSquare)

    const first = resolveNfpBoundary(input, store, 'vertex-pair-hull')
    const second = resolveNfpBoundary(input, store, 'vertex-pair-hull')
    const third = resolveNfpBoundary(input, store, 'vertex-pair-hull')

    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })

  it('keeps rejecting an invalid input ring on every resolution', () => {
    const store = makeStore()
    const collinear = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 4, y: 0 }
    ]
    const input = makeInput(collinear, smallSquare)

    const first = resolveNfpBoundary(input, store, 'vertex-pair-hull')
    const second = resolveNfpBoundary(input, store, 'vertex-pair-hull')

    expect(first.ok).toBe(false)
    expect(second).toEqual(first)
    if (first.ok) throw new Error('expected rejection')
    expect(first.message).toContain('collinear')
  })

  it('revalidates an input array after its coordinates change', () => {
    const store = makeStore()
    const fixed = [
      { x: 0, y: 0 },
      { x: 0, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 0 }
    ]
    const input = makeInput(fixed, smallSquare)

    expect(resolveNfpBoundary(input, store, 'vertex-pair-hull').ok).toBe(true)
    fixed[2] = { x: 2, y: 0 }

    const mutated = resolveNfpBoundary(input, store, 'vertex-pair-hull')
    expect(mutated.ok).toBe(false)
  })

  it('revalidates a previously invalid input after it is corrected in place', () => {
    const store = makeStore()
    const fixed = [
      { x: 0, y: 0 },
      { x: 0, y: 4 },
      { x: 2, y: 0 },
      { x: 4, y: 0 }
    ]
    const input = makeInput(fixed, smallSquare)

    expect(resolveNfpBoundary(input, store, 'vertex-pair-hull').ok).toBe(false)
    fixed[2] = { x: 4, y: 4 }

    expect(resolveNfpBoundary(input, store, 'vertex-pair-hull').ok).toBe(true)
  })

  it('validates equal geometry supplied through a separate array', () => {
    const store = makeStore()
    const shared = resolveNfpBoundary(makeInput(square, smallSquare), store, 'vertex-pair-hull')
    const copied = resolveNfpBoundary(
      makeInput(
        square.map((point) => ({ ...point })),
        smallSquare.map((point) => ({ ...point }))
      ),
      store,
      'vertex-pair-hull'
    )

    expect(copied).toEqual(shared)
  })

  it('still walks rings this process did not store', () => {
    const foreignValid = {
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 3 },
        { x: 3, y: 3 },
        { x: 3, y: 0 }
      ]
    }
    const foreignConcave = {
      points: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 2, y: 1 },
        { x: 4, y: 4 },
        { x: 0, y: 4 }
      ]
    }
    const foreignTooShort = {
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 }
      ]
    }
    const foreignNonFinite = {
      points: [
        { x: 0, y: 0 },
        { x: Number.POSITIVE_INFINITY, y: 3 },
        { x: 3, y: 0 }
      ]
    }

    expect(isValidCachedNfpBoundary(foreignValid)).toBe(true)
    expect(isValidCachedNfpBoundary(foreignConcave)).toBe(false)
    expect(isValidCachedNfpBoundary(foreignTooShort)).toBe(false)
    expect(isValidCachedNfpBoundary(foreignNonFinite)).toBe(false)
    expect(isValidCachedNfpBoundary(undefined)).toBe(false)
    expect(isValidCachedNfpBoundary(null)).toBe(false)
    expect(isValidCachedNfpBoundary({ points: 'not-a-ring' })).toBe(false)
  })

  it('does not trust a previously valid boundary after mutation', () => {
    const boundary = {
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 4 },
        { x: 4, y: 4 },
        { x: 4, y: 0 }
      ]
    }

    expect(isValidCachedNfpBoundary(boundary)).toBe(true)
    boundary.points[2] = { x: 2, y: 0 }
    expect(isValidCachedNfpBoundary(boundary)).toBe(false)
  })

  it('recomputes when a stored entry is replaced by a malformed one', () => {
    const store = makeStore()
    const input = makeInput(square, smallSquare)
    const seeded = resolveNfpBoundary(input, store, 'vertex-pair-hull')
    if (!seeded.ok) throw new Error(seeded.message)

    store.set(seeded.key, { points: [{ x: 0, y: 0 }] })
    const recovered = resolveNfpBoundary(input, store, 'vertex-pair-hull')

    expect(recovered).toEqual(seeded)
  })
})
