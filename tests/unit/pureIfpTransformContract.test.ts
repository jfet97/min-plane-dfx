import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  DEFAULT_IRREGULAR_NESTING_SETTINGS
} from '@shared/irregular/defaults.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  innerFitBoundsCacheKey,
  transformCollisionGeometryCacheKey
} from '../../src/workers/irregular/geometryCacheKeys.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLayer } from '../../src/workers/irregular/nfpIfpService.js'
import {
  GeometryCache,
  IrregularGeometryInfeasibleError,
  IrregularGeometryInputError,
  NfpIfpService,
  cacheKeyToString
} from '../../src/workers/irregular/services.js'

interface CacheEvent {
  readonly operation: 'get' | 'set' | 'remove'
  readonly namespace: string
}

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
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

function transform(
  index = 0,
  rotationDeg = 0,
  mirrored = false
): IrregularTransformCandidate {
  return new IrregularTransformCandidate({
    index,
    rotationDeg,
    mirrored,
    reason: 'configured'
  })
}

function collisionGeometry(
  pieceId: string,
  collisionPoints: ReadonlyArray<IrregularPoint> = [
    point(0, 0),
    point(4, 0),
    point(4, 3),
    point(0, 3)
  ]
): CollisionGeometry {
  return new CollisionGeometry({
    sourcePieceId: PieceId.make(pieceId),
    sourceBounds: bounds(collisionPoints),
    sampledPoints: [...collisionPoints],
    convexHull: polygon(collisionPoints),
    collisionPolygon: polygon(collisionPoints),
    placementReference: point(0, 0),
    diagnostics: []
  })
}

function transformedGeometry(
  pieceId: string,
  points: ReadonlyArray<IrregularPoint> = [
    point(0, 0),
    point(4, 0),
    point(4, 3),
    point(0, 3)
  ],
  selectedTransform = transform()
): TransformedCollisionGeometry {
  return new TransformedCollisionGeometry({
    sourcePieceId: PieceId.make(pieceId),
    transform: selectedTransform,
    polygon: polygon(points),
    bounds: bounds(points)
  })
}

function recordingCacheLayer(
  events: CacheEvent[],
  values = new Map<string, unknown>()
): Layer.Layer<GeometryCache> {
  return Layer.sync(GeometryCache, () => {
    const store: GeometryCache['store'] = {
      get: <A>(key: Parameters<GeometryCache['get']>[0]) => {
        events.push({ operation: 'get', namespace: key.namespace })
        return values.get(cacheKeyToString(key)) as A | undefined
      },
      set: <A>(key: Parameters<GeometryCache['set']>[0], value: A) => {
        events.push({ operation: 'set', namespace: key.namespace })
        values.set(cacheKeyToString(key), value)
      },
      remove: (key: Parameters<GeometryCache['remove']>[0]) => {
        events.push({ operation: 'remove', namespace: key.namespace })
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

function runTransform(
  input: {
    readonly geometry: CollisionGeometry
    readonly transform: IrregularTransformCandidate
  },
  events: CacheEvent[],
  values = new Map<string, unknown>()
) {
  return Effect.runPromise(
    GeometryKernel.use((kernel) => kernel.transformCollisionGeometry(input)).pipe(
      Effect.provide(GeometryKernel.LayerWithCache),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(recordingCacheLayer(events, values))
    )
  )
}

function runIfp(
  input: {
    readonly sheet: SheetSpec
    readonly moving: TransformedCollisionGeometry
  },
  events: CacheEvent[],
  values = new Map<string, unknown>()
) {
  return Effect.runPromise(
    NfpIfpService.use((service) => service.computeIfpBounds(input)).pipe(
      Effect.provide(NfpIfpServiceLayer),
      Effect.provide(recordingCacheLayer(events, values))
    )
  )
}

describe('pure IFP and transformed-cache preservation oracle', () => {
  it('freezes exact transform and IFP cache keys', () => {
    const geometry = collisionGeometry('key-piece')
    const selectedTransform = transform(7, 90, true)
    const transformed = transformedGeometry('key-piece', geometry.collisionPolygon.points, selectedTransform)
    const sheet = new SheetSpec({ width: 20, height: 15, label: 'key sheet' })

    expect(
      cacheKeyToString(
        transformCollisionGeometryCacheKey(
          { geometry, transform: selectedTransform },
          DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
        )
      )
    ).toBe(
      '["transform-collision-v1",["source=key-piece;source-bounds=0,0,4,3;placement-reference=0,0;hull=0,0;4,0;4,3;0,3;collision=0,0;4,0;4,3;0,3","index=7,rotation=90,mirrored=1,reason=configured","flattening-sag=0.25","clearance-margin=0.25","backend=irregular-convex-v2-default","backend-version=0","offset-policy=clipper2-offset-v3-sharp-miter-scale-1000","placement-reference=local-lower-left","transform-operation=mirror-y-then-ccw-rotate"]]'
    )
    expect(cacheKeyToString(innerFitBoundsCacheKey({ sheet, moving: transformed }))).toBe(
      '["sheet-ifp-v1",["sheet=20,15,key sheet","moving-piece=key-piece","moving-transform=index=7,rotation=90,mirrored=1,reason=configured","moving-polygon=0,0;4,0;4,3;0,3","ifp-operation=rectangular-sheet-vertex-bounds"]]'
    )
  })

  it('preserves transform get/set, valid-hit, and stale get/remove/set order', async () => {
    const input = { geometry: collisionGeometry('transform-order'), transform: transform() }
    const key = transformCollisionGeometryCacheKey(
      input,
      DEFAULT_IRREGULAR_NESTING_SETTINGS.geometry
    )
    const values = new Map<string, unknown>()
    const events: CacheEvent[] = []

    const first = await runTransform(input, events, values)
    const second = await runTransform(input, events, values)
    values.set(cacheKeyToString(key), { ...first, polygon: { points: [{ x: 0, y: 0 }] } })
    const afterStale = await runTransform(input, events, values)

    expect(second).toEqual(first)
    expect(afterStale).toEqual(first)
    expect(events).toEqual([
      { operation: 'get', namespace: 'transform-collision-v1' },
      { operation: 'set', namespace: 'transform-collision-v1' },
      { operation: 'get', namespace: 'transform-collision-v1' },
      { operation: 'get', namespace: 'transform-collision-v1' },
      { operation: 'remove', namespace: 'transform-collision-v1' },
      { operation: 'set', namespace: 'transform-collision-v1' }
    ])
  })

  it('preserves transform lookup before invalid-input failure and stores no failure', async () => {
    const events: CacheEvent[] = []
    const failure = await runTransform(
      {
        geometry: collisionGeometry('transform-invalid', [
          point(0, 0),
          point(4, 0),
          point(2, 1),
          point(4, 3),
          point(0, 3)
        ]),
        transform: transform()
      },
      events
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
    expect(failure).toMatchObject({
      _tag: 'IrregularGeometryInputError',
      operation: 'transformCollisionGeometry',
      message: 'polygon must be strictly convex with one consistent winding.'
    })
    expect(events).toEqual([{ operation: 'get', namespace: 'transform-collision-v1' }])
  })

  it('keeps transformed-cache work construction-inert', async () => {
    const events: CacheEvent[] = []
    const input = { geometry: collisionGeometry('transform-lazy'), transform: transform() }

    await Effect.runPromise(
      Effect.gen(function* () {
        const kernel = yield* GeometryKernel
        const pending = kernel.transformCollisionGeometry(input)
        expect(events).toEqual([])
        yield* pending
        expect(events).toEqual([
          { operation: 'get', namespace: 'transform-collision-v1' },
          { operation: 'set', namespace: 'transform-collision-v1' }
        ])
      }).pipe(
        Effect.provide(GeometryKernel.LayerWithCache),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(recordingCacheLayer(events))
      )
    )
  })

  it('preserves IFP validation-before-cache, infeasible miss, and stale order', async () => {
    const sheet = new SheetSpec({ width: 10, height: 8, label: 'ifp order' })
    const invalidEvents: CacheEvent[] = []
    const invalidFailure = await runIfp(
      {
        sheet,
        moving: transformedGeometry('ifp-invalid', [
          point(0, 0),
          point(4, 0),
          point(2, 1),
          point(4, 3),
          point(0, 3)
        ])
      },
      invalidEvents
    ).catch((error: unknown) => error)

    expect(invalidFailure).toBeInstanceOf(IrregularGeometryInputError)
    expect(invalidFailure).toMatchObject({
      _tag: 'IrregularGeometryInputError',
      operation: 'computeIfpBounds',
      message: 'polygon must be strictly convex with one consistent winding.'
    })
    expect(invalidEvents).toEqual([])

    const infeasibleEvents: CacheEvent[] = []
    const infeasibleFailure = await runIfp(
      {
        sheet,
        moving: transformedGeometry('ifp-infeasible', [
          point(-1, 0),
          point(11, 0),
          point(11, 2),
          point(-1, 2)
        ])
      },
      infeasibleEvents
    ).catch((error: unknown) => error)
    expect(infeasibleFailure).toBeInstanceOf(IrregularGeometryInfeasibleError)
    expect(infeasibleFailure).toMatchObject({
      _tag: 'IrregularGeometryInfeasibleError',
      operation: 'computeIfpBounds',
      message: 'moving polygon cannot fit inside the sheet.'
    })
    expect(infeasibleEvents).toEqual([{ operation: 'get', namespace: 'sheet-ifp-v1' }])

    const input = { sheet, moving: transformedGeometry('ifp-stale') }
    const key = innerFitBoundsCacheKey(input)
    const values = new Map<string, unknown>([
      [
        cacheKeyToString(key),
        {
          sheet,
          movingPieceId: input.moving.sourcePieceId,
          bounds: { minX: 0, minY: 0, maxX: 999, maxY: 999 }
        }
      ]
    ])
    const staleEvents: CacheEvent[] = []
    const result = await runIfp(input, staleEvents, values)

    expect(result.bounds).toEqual({ minX: 0, minY: 0, maxX: 6, maxY: 5 })
    expect(staleEvents).toEqual([
      { operation: 'get', namespace: 'sheet-ifp-v1' },
      { operation: 'remove', namespace: 'sheet-ifp-v1' },
      { operation: 'set', namespace: 'sheet-ifp-v1' }
    ])
  })

  it('keeps IFP cache work construction-inert', async () => {
    const events: CacheEvent[] = []
    const input = {
      sheet: new SheetSpec({ width: 10, height: 8, label: 'ifp lazy' }),
      moving: transformedGeometry('ifp-lazy')
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* NfpIfpService
        const pending = service.computeIfpBounds(input)
        expect(events).toEqual([])
        yield* pending
        expect(events).toEqual([
          { operation: 'get', namespace: 'sheet-ifp-v1' },
          { operation: 'set', namespace: 'sheet-ifp-v1' }
        ])
      }).pipe(
        Effect.provide(NfpIfpServiceLayer),
        Effect.provide(recordingCacheLayer(events))
      )
    )
  })
})
