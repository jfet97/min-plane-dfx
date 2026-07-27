import { describe, expect, it } from 'vitest'
import {
  makeInnerFitBoundsCacheKey,
  makeTransformCollisionGeometryCacheKey
} from '../../src/workers/irregular/core/geometryCacheIdentity.js'
import type {
  GeometryCacheKey,
  GeometryCacheStore
} from '../../src/workers/irregular/core/geometryCacheStore.js'
import { serializeGeometryCacheKey } from '../../src/workers/irregular/core/geometryCacheStore.js'
import { resolveIfpBounds } from '../../src/workers/irregular/core/ifpBoundsCore.js'
import { resolveTransformedCollisionGeometry } from '../../src/workers/irregular/core/transformCollisionGeometryCore.js'
import type {
  InternalCollisionGeometry,
  InternalGeometrySettings,
  InternalPoint,
  InternalSheetSpec,
  InternalTransformCandidate,
  InternalTransformedCollisionGeometry
} from '../../src/workers/irregular/internalGeometry.js'

interface CacheAction {
  readonly operation: 'get' | 'set' | 'remove'
  readonly namespace: string
}

const settings: InternalGeometrySettings = {
  flatteningSagToleranceMm: 0.25,
  clearanceSafetyMarginMm: 0.25,
  geometryBackendId: 'irregular-convex-v2-default',
  geometryBackendVersion: '0'
}

function point(x: number, y: number): InternalPoint {
  return { x, y }
}

function transform(
  index = 0,
  rotationDeg = 0,
  mirrored = false
): InternalTransformCandidate {
  return { index, rotationDeg, mirrored, reason: 'configured' }
}

function collisionGeometry(
  sourcePieceId: string,
  points: ReadonlyArray<InternalPoint> = [
    point(0, 0),
    point(4, 0),
    point(4, 3),
    point(0, 3)
  ]
): InternalCollisionGeometry {
  return {
    sourcePieceId,
    sourceBounds: { minX: 0, minY: 0, maxX: 4, maxY: 3 },
    sampledPoints: points,
    convexHull: { points },
    collisionPolygon: { points },
    placementReference: point(0, 0)
  }
}

function transformedGeometry(
  sourcePieceId: string,
  points: ReadonlyArray<InternalPoint> = [
    point(0, 0),
    point(4, 0),
    point(4, 3),
    point(0, 3)
  ]
): InternalTransformedCollisionGeometry {
  return {
    sourcePieceId,
    transform: transform(),
    polygon: { points },
    bounds: { minX: 0, minY: 0, maxX: 4, maxY: 3 }
  }
}

function recordingStore(
  actions: CacheAction[],
  values = new Map<string, unknown>()
): GeometryCacheStore {
  return {
    get: <A>(key: GeometryCacheKey) => {
      actions.push({ operation: 'get', namespace: key.namespace })
      return values.get(serializeGeometryCacheKey(key)) as A | undefined
    },
    set: <A>(key: GeometryCacheKey, value: A) => {
      actions.push({ operation: 'set', namespace: key.namespace })
      values.set(serializeGeometryCacheKey(key), value)
    },
    remove: (key: GeometryCacheKey) => {
      actions.push({ operation: 'remove', namespace: key.namespace })
      values.delete(serializeGeometryCacheKey(key))
    },
    clear: () => values.clear()
  }
}

describe('pure IFP and transformed geometry cores', () => {
  it('resolves and reuses a plain transformed collision artifact without Effect', () => {
    const actions: CacheAction[] = []
    const values = new Map<string, unknown>()
    const input = {
      geometry: collisionGeometry('pure-transform'),
      transform: transform(3, 90, true)
    }
    const store = recordingStore(actions, values)

    const first = resolveTransformedCollisionGeometry(input, settings, store, identity)
    const second = resolveTransformedCollisionGeometry(input, settings, store, identity)

    expect(first).toEqual(second)
    if (!first.ok) throw new Error(first.message)
    expect(Object.getPrototypeOf(first.value)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(first.value.polygon)).toBe(Object.prototype)
    expect(first.value.polygon.points).toEqual([
      point(0, 0),
      point(0, -4),
      point(-3, -4),
      point(-3, 0)
    ])
    expect(actions).toEqual([
      { operation: 'get', namespace: 'transform-collision-v1' },
      { operation: 'set', namespace: 'transform-collision-v1' },
      { operation: 'get', namespace: 'transform-collision-v1' }
    ])
    expect(values.get(serializeGeometryCacheKey(makeTransformCollisionGeometryCacheKey(input, settings)))).toBe(
      first.value
    )
  })

  it('keeps transform failures out of the cache after the required lookup', () => {
    const actions: CacheAction[] = []
    const input = {
      geometry: collisionGeometry('pure-transform-invalid', [
        point(0, 0),
        point(4, 0),
        point(2, 1),
        point(4, 3),
        point(0, 3)
      ]),
      transform: transform()
    }

    const result = resolveTransformedCollisionGeometry(
      input,
      settings,
      recordingStore(actions),
      identity
    )

    expect(result).toEqual({
      ok: false,
      message: 'polygon must be strictly convex with one consistent winding.'
    })
    expect(actions).toEqual([{ operation: 'get', namespace: 'transform-collision-v1' }])
  })

  it('rejects unrepresentable transform coordinates after lookup without storing', () => {
    const actions: CacheAction[] = []
    const result = resolveTransformedCollisionGeometry(
      {
        geometry: collisionGeometry('pure-transform-overflow', [
          point(0, 0),
          point(1e20, 0),
          point(1e20, 1),
          point(0, 1)
        ]),
        transform: transform()
      },
      settings,
      recordingStore(actions),
      identity
    )

    expect(result).toEqual({
      ok: false,
      message: 'transformed collision polygon coordinates must fit the canonical collision grid.'
    })
    expect(actions).toEqual([{ operation: 'get', namespace: 'transform-collision-v1' }])
  })

  it('resolves, caches, and validates plain IFP bounds without Effect', () => {
    const actions: CacheAction[] = []
    const values = new Map<string, unknown>()
    const sheet: InternalSheetSpec = { width: 10, height: 8, label: 'pure ifp' }
    const input = { sheet, moving: transformedGeometry('pure-ifp') }
    const store = recordingStore(actions, values)

    const first = resolveIfpBounds(input, store)
    const second = resolveIfpBounds(input, store)

    expect(first).toEqual(second)
    if (!first.ok) throw new Error(first.message)
    expect(Object.getPrototypeOf(first.value)).toBe(Object.prototype)
    expect(first.value).toEqual({
      sheet,
      movingPieceId: 'pure-ifp',
      bounds: { minX: 0, minY: 0, maxX: 6, maxY: 5 }
    })
    expect(actions).toEqual([
      { operation: 'get', namespace: 'sheet-ifp-v1' },
      { operation: 'set', namespace: 'sheet-ifp-v1' },
      { operation: 'get', namespace: 'sheet-ifp-v1' }
    ])
    expect(values.get(serializeGeometryCacheKey(makeInnerFitBoundsCacheKey(input)))).toBe(first.value)
  })

  it('rejects invalid IFP input before cache access and distinguishes infeasibility', () => {
    const invalidActions: CacheAction[] = []
    const invalid = resolveIfpBounds(
      {
        sheet: { width: 10, height: 8, label: 'invalid' },
        moving: transformedGeometry('pure-ifp-invalid', [
          point(0, 0),
          point(4, 0),
          point(2, 1),
          point(4, 3),
          point(0, 3)
        ])
      },
      recordingStore(invalidActions)
    )
    expect(invalid).toEqual({
      ok: false,
      kind: 'invalid',
      message: 'polygon must be strictly convex with one consistent winding.'
    })
    expect(invalidActions).toEqual([])

    const infeasibleActions: CacheAction[] = []
    const infeasible = resolveIfpBounds(
      {
        sheet: { width: 10, height: 8, label: 'infeasible' },
        moving: transformedGeometry('pure-ifp-infeasible', [
          point(-1, 0),
          point(11, 0),
          point(11, 2),
          point(-1, 2)
        ])
      },
      recordingStore(infeasibleActions)
    )
    expect(infeasible).toEqual({
      ok: false,
      kind: 'infeasible',
      message: 'moving polygon cannot fit inside the sheet.'
    })
    expect(infeasibleActions).toEqual([{ operation: 'get', namespace: 'sheet-ifp-v1' }])
  })

  it('rejects overflowing IFP arithmetic after lookup without storing', () => {
    const actions: CacheAction[] = []
    const result = resolveIfpBounds(
      {
        sheet: { width: Number.MAX_VALUE, height: 8, label: 'overflow' },
        moving: transformedGeometry('pure-ifp-overflow', [
          point(-Number.MAX_VALUE, 0),
          point(-Number.MAX_VALUE / 2, 0),
          point(-Number.MAX_VALUE / 2, 1),
          point(-Number.MAX_VALUE, 1)
        ])
      },
      recordingStore(actions)
    )

    expect(result).toEqual({
      ok: false,
      kind: 'invalid',
      message: 'IFP arithmetic must produce finite bounds.'
    })
    expect(actions).toEqual([{ operation: 'get', namespace: 'sheet-ifp-v1' }])
  })
})

function identity<T>(value: T): T {
  return value
}
