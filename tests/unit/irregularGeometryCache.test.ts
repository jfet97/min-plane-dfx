import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import { DEFAULT_IRREGULAR_GEOMETRY_SETTINGS } from '@shared/irregular/defaults.js'
import {
  CollisionGeometry,
  IrregularBounds,
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
  NfpIfpService,
  cacheKeyToString
} from '../../src/workers/irregular/services.js'
import { transformCollisionGeometryCacheKey } from '../../src/workers/irregular/geometryCacheKeys.js'
import { NfpIfpServiceLayer } from '../../src/workers/irregular/nfpIfpService.js'

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

function transformedGeometry(pieceId: string, size: number): TransformedCollisionGeometry {
  const points = squarePoints(size)
  return new TransformedCollisionGeometry({
    sourcePieceId: PieceId.make(pieceId),
    transform: transform(0),
    polygon: polygon(points),
    bounds: bounds(points)
  })
}

function placedPiece(pieceId: string, size: number): IrregularPlacedPiece {
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: PieceId.make(pieceId),
      transform: new IrregularTransform({
        translateX: 0,
        translateY: 0,
        rotationDeg: 0,
        mirrored: false
      })
    }),
    collisionGeometry: transformedGeometry(pieceId, size)
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

function cacheLayer(counters: CacheCounters) {
  const values = new Map<string, unknown>()
  return Layer.sync(GeometryCache, () => ({
    get: <A>(key: Parameters<GeometryCache['get']>[0]) =>
      Effect.sync(() => {
        counters.gets += 1
        return values.get(cacheKeyToString(key)) as A | undefined
      }),
    set: <A>(key: Parameters<GeometryCache['set']>[0], value: A) =>
      Effect.sync(() => {
        counters.sets += 1
        values.set(cacheKeyToString(key), value)
      }),
    remove: (key: Parameters<GeometryCache['remove']>[0]) =>
      Effect.sync(() => {
        counters.removes += 1
        values.delete(cacheKeyToString(key))
      }),
    clear: Effect.sync(() => {
      values.clear()
    })
  }))
}

describe('irregular geometry caches', () => {
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
})
