import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import { DEFAULT_IRREGULAR_GEOMETRY_SETTINGS } from '@shared/irregular/defaults.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularGeometrySettings,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import {
  GeometryCache,
  GeometryCacheLive,
  NfpIfpService,
  cacheKeyToString
} from '../../src/workers/irregular/services.js'
import type { ComputeNfpInput } from '../../src/workers/irregular/services.js'
import {
  innerFitBoundsCacheKey,
  pairwiseNfpCacheKey,
  transformCollisionGeometryCacheKey
} from '../../src/workers/irregular/geometryCacheKeys.js'
import {
  makeNfpIfpServiceLayer,
  NfpIfpServiceLayer
} from '../../src/workers/irregular/nfpIfpService.js'
import {
  disableNfpIfpTelemetry,
  enableNfpIfpTelemetry,
  nfpIfpTelemetrySnapshot
} from '../../src/workers/irregular/nfpIfpTelemetry.js'

afterEach(() => {
  disableNfpIfpTelemetry()
})

interface CacheCounters {
  gets: number
  sets: number
  removes: number
}

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function squarePoints(size: number): ReadonlyArray<IrregularPoint> {
  return [point(0, 0), point(size, 0), point(size, size), point(0, size)]
}

function polygon(points: ReadonlyArray<IrregularPoint>): IrregularPolygon {
  return new IrregularPolygon({ points })
}

function bounds(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  return new IrregularBounds({
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y))
  })
}

function transform(index: number): IrregularTransformCandidate {
  return new IrregularTransformCandidate({
    index,
    rotationDeg: index === 0 ? 0 : 90,
    mirrored: false,
    reason: 'configured'
  })
}

function transformedGeometry(
  pieceId: string,
  size: number,
  transformCandidate = transform(0),
  points = squarePoints(size)
): TransformedCollisionGeometry {
  return new TransformedCollisionGeometry({
    sourcePieceId: PieceId.make(pieceId),
    transform: transformCandidate,
    polygon: polygon(points),
    bounds: bounds(points)
  })
}

function placedPiece(
  pieceId: string,
  size: number,
  translateX = 0,
  translateY = 0,
  points = squarePoints(size),
  transformCandidate = transform(0)
): IrregularPlacedPiece {
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: PieceId.make(pieceId),
      transform: new IrregularTransform({
        translateX,
        translateY,
        rotationDeg: 0,
        mirrored: false
      })
    }),
    collisionGeometry: transformedGeometry(pieceId, size, transformCandidate, points)
  })
}

function collisionGeometry(pieceId: string): CollisionGeometry {
  const points = squarePoints(2)
  return new CollisionGeometry({
    sourcePieceId: PieceId.make(pieceId),
    sourceBounds: bounds(points),
    sampledPoints: points,
    convexHull: polygon(points),
    collisionPolygon: polygon(points),
    placementReference: point(0, 0),
    diagnostics: []
  })
}

function cacheLayer(counters: CacheCounters, values = new Map<string, unknown>()) {
  return Layer.sync(GeometryCache, () => {
    const store: GeometryCache['store'] = {
      get: <A>(key: Parameters<GeometryCache['get']>[0]) => {
        counters.gets += 1
        return values.get(cacheKeyToString(key)) as A | undefined
      },
      set: <A>(key: Parameters<GeometryCache['set']>[0], value: A) => {
        counters.sets += 1
        values.set(cacheKeyToString(key), value)
      },
      remove: (key: Parameters<GeometryCache['remove']>[0]) => {
        counters.removes += 1
        values.delete(cacheKeyToString(key))
      },
      clear: () => values.clear()
    }
    return {
      store,
      get: <A>(key: Parameters<GeometryCache['get']>[0]) =>
        Effect.sync(() => store.get<A>(key)),
      set: <A>(key: Parameters<GeometryCache['set']>[0], value: A) =>
        Effect.sync(() => store.set(key, value)),
      remove: (key: Parameters<GeometryCache['remove']>[0]) =>
        Effect.sync(() => store.remove(key)),
      clear: Effect.sync(() => store.clear())
    }
  })
}

function computeNfpWithCache(
  input: ComputeNfpInput,
  counters: CacheCounters,
  values = new Map<string, unknown>()
) {
  return Effect.runPromise(
    NfpIfpService.use((service) => service.computeNfp(input)).pipe(
      Effect.provide(NfpIfpServiceLayer),
      Effect.provide(cacheLayer(counters, values))
    )
  )
}

describe('irregular geometry caches', () => {
  it('keeps live sync and Effect views coherent across stale, hit, and clear telemetry', async () => {
    enableNfpIfpTelemetry()
    const input = {
      fixed: placedPiece('fixed-cache-views', 2),
      moving: transformedGeometry('moving-cache-views', 1),
      settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    }
    const key = pairwiseNfpCacheKey(input)
    const liveLayer = makeNfpIfpServiceLayer().pipe(Layer.provideMerge(GeometryCacheLive))

    const observations = await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* GeometryCache
        const service = yield* NfpIfpService
        cache.store.set(key, { points: [{ x: 0, y: 0 }] })
        const afterStale = yield* service.computeNfp(input)
        const throughEffect = yield* service.computeNfp(input)
        yield* cache.clear
        const afterClear = cache.store.get(key)
        return { afterStale, throughEffect, afterClear }
      }).pipe(Effect.provide(liveLayer))
    )

    expect(observations.afterStale).toEqual(observations.throughEffect)
    expect(observations.afterClear).toBeUndefined()
    expect(nfpIfpTelemetrySnapshot()?.cacheInstances).toBe(1)
    expect(
      nfpIfpTelemetrySnapshot()?.namespaces['pairwise-nfp-relative-v3']
    ).toEqual({
      getCalls: 3,
      getPresent: 2,
      setCalls: 2,
      removeCalls: 1
    })
  })

  it('keeps live sync and Effect cache work invisible while telemetry is disabled', async () => {
    const input = {
      fixed: placedPiece('fixed-cache-disabled', 2),
      moving: transformedGeometry('moving-cache-disabled', 1),
      settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    }
    const key = pairwiseNfpCacheKey(input)
    const liveLayer = makeNfpIfpServiceLayer().pipe(Layer.provideMerge(GeometryCacheLive))

    await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* GeometryCache
        const service = yield* NfpIfpService
        cache.store.set(key, { points: [{ x: 0, y: 0 }] })
        yield* service.computeNfp(input)
        yield* service.computeNfp(input)
        yield* cache.clear
        cache.store.get(key)
      }).pipe(Effect.provide(liveLayer))
    )

    expect(nfpIfpTelemetrySnapshot()).toBeUndefined()
  })

  it('tracks transform and IFP miss, hit, stale, mixed access, and clear through one live store', async () => {
    enableNfpIfpTelemetry()
    const transformInput = {
      geometry: collisionGeometry('live-transform-cache'),
      transform: transform(0)
    }
    const ifpInput = {
      sheet: new SheetSpec({ width: 10, height: 8, label: 'live IFP cache' }),
      moving: transformedGeometry('live-ifp-cache', 2)
    }
    const transformKey = transformCollisionGeometryCacheKey(
      transformInput,
      DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    )
    const ifpKey = innerFitBoundsCacheKey(ifpInput)
    const liveLayer = Layer.merge(
      GeometryKernel.LayerWithCache.pipe(Layer.provide(GeometrySettings.Live)),
      NfpIfpServiceLayer
    ).pipe(Layer.provideMerge(GeometryCacheLive))

    await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* GeometryCache
        const kernel = yield* GeometryKernel
        const service = yield* NfpIfpService
        yield* cache.set(transformKey, { polygon: { points: [] } })
        cache.store.set(ifpKey, { bounds: { minX: 0, minY: 0, maxX: 999, maxY: 999 } })

        const transformAfterStale = yield* kernel.transformCollisionGeometry(transformInput)
        const ifpAfterStale = yield* service.computeIfpBounds(ifpInput)
        const transformHit = yield* kernel.transformCollisionGeometry(transformInput)
        const ifpHit = yield* service.computeIfpBounds(ifpInput)

        expect(transformHit).toBe(transformAfterStale)
        expect(ifpHit).toEqual(ifpAfterStale)

        yield* cache.clear
        yield* cache.get(transformKey)
        cache.store.get(ifpKey)
      }).pipe(Effect.provide(liveLayer))
    )

    expect(nfpIfpTelemetrySnapshot()?.cacheInstances).toBe(1)
    expect(nfpIfpTelemetrySnapshot()?.namespaces['transform-collision-v1']).toEqual({
      getCalls: 3,
      getPresent: 2,
      setCalls: 2,
      removeCalls: 1
    })
    expect(nfpIfpTelemetrySnapshot()?.namespaces['sheet-ifp-v1']).toEqual({
      getCalls: 3,
      getPresent: 2,
      setCalls: 2,
      removeCalls: 1
    })
  })

  it('keeps live transform and IFP cache work invisible while telemetry is disabled', async () => {
    const transformInput = {
      geometry: collisionGeometry('disabled-transform-cache'),
      transform: transform(0)
    }
    const ifpInput = {
      sheet: new SheetSpec({ width: 10, height: 8, label: 'disabled IFP cache' }),
      moving: transformedGeometry('disabled-ifp-cache', 2)
    }
    const liveLayer = Layer.merge(
      GeometryKernel.LayerWithCache.pipe(Layer.provide(GeometrySettings.Live)),
      NfpIfpServiceLayer
    ).pipe(Layer.provideMerge(GeometryCacheLive))

    await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* GeometryCache
        const kernel = yield* GeometryKernel
        const service = yield* NfpIfpService
        yield* kernel.transformCollisionGeometry(transformInput)
        yield* kernel.transformCollisionGeometry(transformInput)
        yield* service.computeIfpBounds(ifpInput)
        yield* service.computeIfpBounds(ifpInput)
        yield* cache.clear
      }).pipe(Effect.provide(liveLayer))
    )

    expect(nfpIfpTelemetrySnapshot()).toBeUndefined()
  })

  it('reuses transformed collision geometry and separates transform keys', async () => {
    const counters = { gets: 0, sets: 0, removes: 0 }
    const geometry = collisionGeometry('transform-cache')
    const input = { geometry, transform: transform(0) }
    const firstKey = transformCollisionGeometryCacheKey(input, DEFAULT_IRREGULAR_GEOMETRY_SETTINGS)
    const secondKey = transformCollisionGeometryCacheKey(
      { geometry, transform: transform(1) },
      DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    )

    const transformed = await Effect.runPromise(
      GeometryKernel.use((kernel) =>
        Effect.all([
          kernel.transformCollisionGeometry(input),
          kernel.transformCollisionGeometry(input)
        ])
      ).pipe(
        Effect.provide(GeometryKernel.LayerWithCache),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(cacheLayer(counters))
      )
    )

    expect(transformed[0]).toEqual(transformed[1])
    expect(firstKey).not.toEqual(secondKey)
    expect(counters.gets).toBe(2)
    expect(counters.sets).toBe(1)
  })

  it('reuses pairwise NFP and IFP artifacts without caching invalid geometry', async () => {
    const counters = { gets: 0, sets: 0, removes: 0 }
    const moving = transformedGeometry('moving-cache', 2)
    const fixed = placedPiece('fixed-cache', 2)
    const input = {
      fixed,
      moving,
      settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    }
    const sheet = new SheetSpec({ width: 10, height: 10, label: 'cache sheet' })

    const result = await Effect.runPromise(
      NfpIfpService.use((service) =>
        Effect.all([
          service.computeNfp(input),
          service.computeNfp(input),
          service.computeIfpBounds({ sheet, moving }),
          service.computeIfpBounds({ sheet, moving })
        ])
      ).pipe(Effect.provide(NfpIfpServiceLayer), Effect.provide(cacheLayer(counters)))
    )

    expect(result[0]).toEqual(result[1])
    expect(result[2]).toEqual(result[3])
    expect(counters.gets).toBe(4)
    expect(counters.sets).toBe(2)

    const invalidMoving = new TransformedCollisionGeometry({
      ...moving,
      sourcePieceId: PieceId.make('invalid-moving-cache'),
      polygon: polygon([point(0, 0), point(2, 0), point(1, 1), point(2, 2), point(0, 2)])
    })
    const failure = await Effect.runPromise(
      NfpIfpService.use((service) =>
        service.computeNfp({ ...input, moving: invalidMoving }).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => undefined
          })
        )
      ).pipe(
        Effect.provide(NfpIfpServiceLayer),
        Effect.provide(cacheLayer({ gets: 0, sets: 0, removes: 0 }))
      )
    )

    expect(failure?._tag).toBe('IrregularGeometryInputError')
  })

  it('shares one relative NFP boundary across copies with canonical equivalent geometry', async () => {
    const counters = { gets: 0, sets: 0, removes: 0 }
    const values = new Map<string, unknown>()
    const firstInput = {
      fixed: placedPiece('fixed-copy-a', 2),
      moving: transformedGeometry('moving-copy-a', 1),
      settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    }
    const secondInput = {
      fixed: placedPiece('fixed-copy-b', 2, 0, 0, [
        point(2, 2),
        point(0, 2),
        point(0, 0),
        point(2, 0)
      ]),
      moving: transformedGeometry('moving-copy-b', 1, transform(0), [
        point(1, 0),
        point(1, 1),
        point(0, 1),
        point(0, 0)
      ]),
      settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    }

    const [first, second] = await Effect.runPromise(
      NfpIfpService.use((service) =>
        Effect.all([service.computeNfp(firstInput), service.computeNfp(secondInput)])
      ).pipe(Effect.provide(NfpIfpServiceLayer), Effect.provide(cacheLayer(counters, values)))
    )

    expect(counters).toEqual({ gets: 2, sets: 1, removes: 0 })
    expect(first.fixedPieceId).toBe('fixed-copy-a')
    expect(first.movingPieceId).toBe('moving-copy-a')
    expect(second.fixedPieceId).toBe('fixed-copy-b')
    expect(second.movingPieceId).toBe('moving-copy-b')
    expect(first.boundary).toEqual(second.boundary)

    const firstKey = pairwiseNfpCacheKey(firstInput)
    const secondKey = pairwiseNfpCacheKey(secondInput)
    expect(firstKey).toEqual(secondKey)
    const cachedBoundary = values.get(cacheKeyToString(firstKey))
    expect(cachedBoundary).toEqual(first.boundary)
    expect(cachedBoundary).not.toHaveProperty('fixedPieceId')
    expect(cachedBoundary).not.toHaveProperty('movingPieceId')
  })

  it('translates a cached relative boundary without recomputing it', async () => {
    const counters = { gets: 0, sets: 0, removes: 0 }
    const firstInput = {
      fixed: placedPiece('fixed-origin', 2),
      moving: transformedGeometry('moving-origin', 2),
      settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    }
    const translatedInput = {
      fixed: placedPiece('fixed-translated-copy', 2, 10, -3),
      moving: transformedGeometry('moving-translated-copy', 2),
      settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    }

    const [first, translated] = await Effect.runPromise(
      NfpIfpService.use((service) =>
        Effect.all([service.computeNfp(firstInput), service.computeNfp(translatedInput)])
      ).pipe(Effect.provide(NfpIfpServiceLayer), Effect.provide(cacheLayer(counters)))
    )

    expect(counters).toEqual({ gets: 2, sets: 1, removes: 0 })
    expect(translated.boundary.points).toEqual(
      first.boundary.points.map(({ x, y }) => point(x + 10, y - 3))
    )
    expect(translated).not.toBe(first)
    expect(translated.boundary).not.toBe(first.boundary)
  })

  it('misses relative NFP entries when geometry, transform, or settings change', async () => {
    const counters = { gets: 0, sets: 0, removes: 0 }
    const fixed = placedPiece('fixed-identity', 2)
    const moving = transformedGeometry('moving-identity', 2)
    const settings = new IrregularGeometrySettings({
      ...DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
      geometryBackendVersion: '1'
    })

    await Effect.runPromise(
      NfpIfpService.use((service) =>
        Effect.all([
          service.computeNfp({
            fixed,
            moving,
            settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
          }),
          service.computeNfp({
            fixed,
            moving: transformedGeometry('moving-geometry-change', 3),
            settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
          }),
          service.computeNfp({
            fixed,
            moving: transformedGeometry('moving-transform-change', 2, transform(1)),
            settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
          }),
          service.computeNfp({ fixed, moving, settings })
        ])
      ).pipe(Effect.provide(NfpIfpServiceLayer), Effect.provide(cacheLayer(counters)))
    )

    expect(counters).toEqual({ gets: 4, sets: 4, removes: 0 })
  })

  it('keeps cached and uncached NFP results identical', async () => {
    const input = {
      fixed: placedPiece('fixed-parity', 3, 4, 5),
      moving: transformedGeometry('moving-parity', 2),
      settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    }
    const uncachedCounters = { gets: 0, sets: 0, removes: 0 }
    const cachedCounters = { gets: 0, sets: 0, removes: 0 }
    const values = new Map<string, unknown>()

    const uncached = await computeNfpWithCache(input, uncachedCounters)
    const cachedFirst = await computeNfpWithCache(input, cachedCounters, values)
    const cachedSecond = await computeNfpWithCache(input, cachedCounters, values)

    expect(uncached).toEqual(cachedFirst)
    expect(uncached).toEqual(cachedSecond)
    expect(uncachedCounters).toEqual({ gets: 1, sets: 1, removes: 0 })
    expect(cachedCounters).toEqual({ gets: 2, sets: 1, removes: 0 })
  })

  it('evicts cached values that are not valid strict convex boundaries', async () => {
    const counters = { gets: 0, sets: 0, removes: 0 }
    const values = new Map<string, unknown>()
    const input = {
      fixed: placedPiece('fixed-invalid-cache', 2),
      moving: transformedGeometry('moving-invalid-cache', 2),
      settings: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    }
    const key = pairwiseNfpCacheKey(input)
    values.set(
      cacheKeyToString(key),
      polygon([point(0, 0), point(2, 0), point(1, 1), point(2, 2), point(0, 2)])
    )

    const result = await computeNfpWithCache(input, counters, values)

    expect(result.boundary.points.length).toBeGreaterThanOrEqual(3)
    expect(counters).toEqual({ gets: 1, sets: 1, removes: 1 })
  })
})
