import { describe, expect, it } from 'vitest'
import {
  computeRelativeNfpBoundary,
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

describe('pure NFP boundary core', () => {
  it('keeps exact key serialization and coherent miss, hit, stale, and clear behavior', () => {
    const cache = makeRecordingCache()
    const input = makeInput()

    const miss = resolveNfpBoundary(input, cache.store, 'vertex-pair-hull')
    expect(miss.ok).toBe(true)
    if (!miss.ok) throw new Error(miss.message)
    expect(serializeGeometryCacheKey(miss.key)).toBe(
      JSON.stringify([miss.key.namespace, miss.key.parts])
    )
    expect(miss.key).toEqual({
      namespace: 'pairwise-nfp-relative-v3',
      parts: [
        'fixed-polygon=0,0;0,4;4,4;4,0',
        'moving-polygon=0,0;0,2;2,2;2,0',
        'fixed-transform=index=0,rotation=0,mirrored=0,reason=configured',
        'moving-transform=index=0,rotation=0,mirrored=0,reason=configured',
        'flattening-sag=0.05',
        'clearance-margin=0.05',
        'backend=clipper2-ts',
        'backend-version=2.0.1-18',
        'offset-policy=clipper2-offset-v3-sharp-miter-scale-1000',
        'nfp-algorithm=convex-fixed-plus-negated-moving-relative-v3',
        'nfp-construction=vertex-pair-hull'
      ]
    })
    expect(cache.actions).toEqual(['get:miss', 'set'])

    cache.actions.length = 0
    const hit = resolveNfpBoundary(input, cache.store, 'vertex-pair-hull')
    expect(hit).toEqual(miss)
    expect(cache.actions).toEqual(['get:hit'])

    cache.values.set(serializeGeometryCacheKey(miss.key), {
      points: [{ x: 0, y: 0 }]
    })
    cache.actions.length = 0
    const stale = resolveNfpBoundary(input, cache.store, 'vertex-pair-hull')
    expect(stale).toEqual(miss)
    expect(cache.actions).toEqual(['get:hit', 'remove', 'set'])

    cache.store.clear()
    expect(cache.values.size).toBe(0)
    expect(cache.actions.at(-1)).toBe('clear')
  })

  it('performs no cache action for invalid input', () => {
    const cache = makeRecordingCache()
    const input = makeInput()
    const result = resolveNfpBoundary(
      {
        ...input,
        moving: {
          ...input.moving,
          polygon: { points: [{ x: 0, y: 0 }] }
        }
      },
      cache.store,
      'vertex-pair-hull'
    )

    expect(result).toEqual({
      ok: false,
      message: 'polygon must contain at least three vertices.'
    })
    expect(cache.actions).toEqual([])
  })

  it('stores nothing when relative construction overflows', () => {
    const cache = makeRecordingCache()
    const result = resolveNfpBoundary(
      makeInput(
        rectangle(0, 0, 1e308, 1e307),
        rectangle(-1e308, 0, 0, 1e307)
      ),
      cache.store,
      'vertex-pair-hull'
    )

    expect(result).toEqual({
      ok: false,
      message: 'Minkowski sum must produce finite coordinates.'
    })
    expect(cache.actions).toEqual(['get:miss'])
    expect(cache.values.size).toBe(0)
  })

  it('retains the relative boundary when translated construction overflows', () => {
    const cache = makeRecordingCache()
    const input = makeInput(rectangle(0, 0, 1e308, 1e307), square(2))
    const result = resolveNfpBoundary(
      {
        ...input,
        fixed: {
          ...input.fixed,
          placement: { transform: { translateX: 1e308, translateY: 0 } }
        }
      },
      cache.store,
      'vertex-pair-hull'
    )

    expect(result).toEqual({
      ok: false,
      message: 'fixed translation must produce finite coordinates.'
    })
    expect(cache.actions).toEqual(['get:miss', 'set'])
    expect(cache.values.size).toBe(1)
  })

  it('matches reference and linear construction on structural polygons', () => {
    const fixed = [
      { x: -3, y: -1 },
      { x: 0, y: -3 },
      { x: 4, y: -2 },
      { x: 5, y: 1 },
      { x: 2, y: 4 },
      { x: -2, y: 3 }
    ]
    const moving = [
      { x: 2, y: -1 },
      { x: 0, y: -3 },
      { x: -2, y: -1 },
      { x: -3, y: 2 },
      { x: 1, y: 4 },
      { x: 4, y: 1 }
    ]

    expect(computeRelativeNfpBoundary(fixed, moving, 'linear-edge-merge')).toEqual(
      computeRelativeNfpBoundary(fixed, moving, 'vertex-pair-hull')
    )
  })
})

function makeInput(
  fixedPoints = square(4),
  movingPoints = square(2)
): CoreNfpInput {
  return {
    fixed: {
      collisionGeometry: { polygon: { points: fixedPoints }, transform },
      placement: { transform: { translateX: 0, translateY: 0 } }
    },
    moving: { polygon: { points: movingPoints }, transform },
    settings
  }
}

function square(size: number) {
  return rectangle(0, 0, size, size)
}

function rectangle(minX: number, minY: number, maxX: number, maxY: number) {
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY }
  ]
}

function makeRecordingCache(): {
  readonly store: GeometryCacheStore
  readonly values: Map<string, unknown>
  readonly actions: string[]
} {
  const values = new Map<string, unknown>()
  const actions: string[] = []
  const keyString = (key: GeometryCacheKey) => serializeGeometryCacheKey(key)
  return {
    values,
    actions,
    store: {
      get: <A>(key: GeometryCacheKey) => {
        const value = values.get(keyString(key)) as A | undefined
        actions.push(value === undefined ? 'get:miss' : 'get:hit')
        return value
      },
      set: <A>(key: GeometryCacheKey, value: A) => {
        actions.push('set')
        values.set(keyString(key), value)
      },
      remove: (key: GeometryCacheKey) => {
        actions.push('remove')
        values.delete(keyString(key))
      },
      clear: () => {
        actions.push('clear')
        values.clear()
      }
    }
  }
}
