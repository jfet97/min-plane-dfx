import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError
} from '../../src/workers/irregular/services.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularGeometrySettings,
  IrregularNestingSettings,
  IrregularPoint,
  IrregularPolygon,
  IrregularTransformCandidate
} from '@shared/irregular/domain.js'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { Rect } from '@shared/domain/geometry.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function runConvexHull(points: ReadonlyArray<IrregularPoint>) {
  return Effect.runPromise(
    GeometryKernel.use((kernel) => kernel.convexHull(points)).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live)
    )
  )
}

function polygon(points: ReadonlyArray<IrregularPoint>): IrregularPolygon {
  return new IrregularPolygon({ points })
}

function runConvexOffset(input: {
  readonly polygon: IrregularPolygon
  readonly totalPaddingMm: number
}) {
  return Effect.runPromise(
    GeometryKernel.use((kernel) => kernel.offsetConvexPolygon(input)).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live)
    )
  )
}

function runConvexOffsetWithSettings(
  input: { readonly polygon: IrregularPolygon; readonly totalPaddingMm: number },
  settings: IrregularGeometrySettings
) {
  return Effect.runPromise(
    GeometryKernel.use((kernel) => kernel.offsetConvexPolygon(input)).pipe(
      Effect.provide(GeometryKernel.Layer),
      Effect.provide(
        Layer.succeed(
          GeometrySettings,
          new IrregularNestingSettings({
            geometry: settings,
            optimizer: GeometrySettings.Make.optimizer
          })
        )
      )
    )
  )
}

function collisionGeometry(points: ReadonlyArray<IrregularPoint>): CollisionGeometry {
  return new CollisionGeometry({
    sourcePieceId: PieceId.make('transform-piece'),
    sourceBounds: new IrregularBounds({ minX: 10, minY: 20, maxX: 14, maxY: 23 }),
    sampledPoints: [point(10, 20), point(14, 20), point(14, 23), point(10, 23)],
    convexHull: polygon([point(1.25, 1.25), point(5.25, 1.25), point(5.25, 4.25), point(1.25, 4.25)]),
    collisionPolygon: polygon(points),
    placementReference: point(8.75, 18.75),
    diagnostics: []
  })
}

function transformCandidate(input: {
  readonly rotationDeg: number
  readonly mirrored?: boolean
}): IrregularTransformCandidate {
  return new IrregularTransformCandidate({
    index: 0,
    rotationDeg: input.rotationDeg,
    mirrored: input.mirrored ?? false,
    reason: 'orthogonal'
  })
}

function runCollisionTransform(input: {
  readonly geometry: CollisionGeometry
  readonly transform: IrregularTransformCandidate
}) {
  return Effect.runPromise(
    GeometryKernel.use((kernel) => kernel.transformCollisionGeometry(input)).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live)
    )
  )
}

function quarterArcPiece(): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make('quarter-arc'),
    sourceFileId: SourceFileId.make('test-source'),
    label: 'Quarter arc',
    realBounds: new Rect({ x: 0, y: 0, width: 10, height: 10 }),
    geometry: new DxfGeometrySummary({
      entityType: 'ARC',
      closed: false,
      segments: [
        {
          kind: 'arc',
          x1: 10,
          y1: 0,
          x2: 0,
          y2: 10,
          cx: 0,
          cy: 0,
          radius: 10,
          startAngle: 0,
          endAngle: 90
        }
      ]
    }),
    warnings: []
  })
}

describe('GeometryKernel', () => {
  it('uses flattening tolerance from the provided settings service', async () => {
    const settings = new IrregularGeometrySettings({
      flatteningSagToleranceMm: 0.125,
      clearanceSafetyMarginMm: 0.25,
      geometryBackendId: 'test-geometry-backend',
      geometryBackendVersion: 'settings-proof'
    })

    const flattened = await Effect.runPromise(
      GeometryKernel.use((kernel) => kernel.flattenSourceGeometry({ piece: quarterArcPiece() })).pipe(
        Effect.provide(GeometryKernel.Layer),
        Effect.provide(
          Layer.succeed(
            GeometrySettings,
            new IrregularNestingSettings({
              geometry: settings,
              optimizer: GeometrySettings.Make.optimizer
            })
          )
        )
      )
    )

    expect(flattened.sampledPoints).toHaveLength(6)
  })

  it('keeps Unimplemented independent from geometry settings', async () => {
    const failure = await Effect.runPromise(
      GeometryKernel.use((kernel) => kernel.convexHull([])).pipe(
        Effect.match({
          onFailure: (err) => err,
          onSuccess: () => null
        }),
        Effect.provide(GeometryKernel.Unimplemented)
      )
    )

    expect(failure).toBeInstanceOf(IrregularNestingNotImplementedError)
    expect(failure?.message).toBe('GeometryKernel.convexHull is intentionally unimplemented.')
  })

  it('returns a canonical counter-clockwise hull without duplicate, interior, or collinear points', async () => {
    const hull = await runConvexHull([
      point(2, 1),
      point(0, 3),
      point(4, 0),
      point(2, 0),
      point(0, 0),
      point(4, 3),
      point(4, 0),
      point(0, 0)
    ])

    expect(hull.points).toEqual([point(0, 0), point(4, 0), point(4, 3), point(0, 3)])
  })

  it('returns the same canonical hull regardless of source point order', async () => {
    const points = [
      point(4, 3),
      point(0, 0),
      point(0, 3),
      point(4, 0),
      point(2, 1),
      point(2, 0)
    ]

    const [forward, reverse] = await Promise.all([runConvexHull(points), runConvexHull([...points].reverse())])

    expect(forward).toEqual(reverse)
  })

  it('retains a near-collinear corner when the ordinary determinant rounds to zero', async () => {
    const epsilon = Number.EPSILON

    const hull = await runConvexHull([
      point(0, 0),
      point(1 + epsilon, 1),
      point(1, 1 - epsilon)
    ])

    expect(hull.points).toEqual([
      point(0, 0),
      point(1, 1 - epsilon),
      point(1 + epsilon, 1)
    ])
  })

  it('derives an offset from half total padding plus the configured clearance margin', async () => {
    const settings = new IrregularGeometrySettings({
      flatteningSagToleranceMm: 0.25,
      clearanceSafetyMarginMm: 0.5,
      geometryBackendId: 'test-geometry-backend',
      geometryBackendVersion: 'settings-proof'
    })

    const offset = await runConvexOffsetWithSettings({
      polygon: polygon([point(0, 0), point(4, 0), point(4, 3), point(0, 3)]),
      totalPaddingMm: 2
    }, settings)

    expect(offset.points).toEqual([
      point(-1.502, -1.502),
      point(5.502, -1.502),
      point(5.502, 4.502),
      point(-1.502, 4.502)
    ])
  })

  it('expands a clockwise polygon outward without changing its winding', async () => {
    const offset = await runConvexOffset({
      polygon: polygon([point(0, 0), point(0, 3), point(4, 3), point(4, 0)]),
      totalPaddingMm: 1.5
    })

    expect(offset.points).toEqual([
      point(-1.002, -1.002),
      point(-1.002, 4.002),
      point(5.002, 4.002),
      point(5.002, -1.002)
    ])
  })

  it('preserves a sharp Miter join within the configured ratio', async () => {
    const offset = await runConvexOffset({
      polygon: polygon([point(0, 0), point(4, 0), point(0, 3)]),
      totalPaddingMm: 1.5
    })

    expect(offset.points).toEqual([
      point(-1.002, -1.002),
      point(7.006, -1.002),
      point(-1.002, 5.004)
    ])
  })

  it('rejects a negative padding value through the offset input schema', async () => {
    const failure = await Effect.runPromise(
      GeometryKernel.use((kernel) =>
        kernel.offsetConvexPolygon({
          polygon: polygon([point(0, 0), point(4, 0), point(4, 3), point(0, 3)]),
          totalPaddingMm: -1
        })
      ).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => null
        }),
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live)
      )
    )

    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
    expect(failure?.operation).toBe('offsetConvexPolygon')
    expect(failure?.message).toBe('offset input must satisfy the shared offset geometry schema.')
  })

  it('rejects a non-convex polygon instead of silently producing a false collision shape', async () => {
    const failure = await Effect.runPromise(
      GeometryKernel.use((kernel) =>
        kernel.offsetConvexPolygon({
          polygon: polygon([point(0, 0), point(4, 0), point(2, 1), point(4, 3), point(0, 3)]),
          totalPaddingMm: 1
        })
      ).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => null
        }),
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live)
      )
    )

    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
    expect(failure?.message).toBe('polygon must be strictly convex with one consistent winding.')
  })

  it('rotates collision geometry counter-clockwise around its unchanged placement reference', async () => {
    const source = collisionGeometry([
      point(0, 0),
      point(6.5, 0),
      point(6.5, 5.5),
      point(0, 5.5)
    ])

    const transformed = await runCollisionTransform({
      geometry: source,
      transform: transformCandidate({ rotationDeg: 90 })
    })

    expect(transformed.polygon.points).toEqual([
      point(0, 0),
      point(0, 6.5),
      point(-5.5, 6.5),
      point(-5.5, 0)
    ])
    expect(transformed.bounds).toEqual(
      new IrregularBounds({ minX: -5.5, minY: 0, maxX: 0, maxY: 6.5 })
    )
    expect(source.collisionPolygon.points).toEqual([
      point(0, 0),
      point(6.5, 0),
      point(6.5, 5.5),
      point(0, 5.5)
    ])
  })

  it('mirrors before rotating and keeps orthogonal rotations exact', async () => {
    const transformed = await runCollisionTransform({
      geometry: collisionGeometry([
        point(0, 0),
        point(6.5, 0),
        point(6.5, 5.5),
        point(0, 5.5)
      ]),
      transform: transformCandidate({ rotationDeg: 450, mirrored: true })
    })

    expect(transformed.polygon.points).toEqual([
      point(0, 0),
      point(0, -6.5),
      point(-5.5, -6.5),
      point(-5.5, 0)
    ])
    expect(transformed.bounds).toEqual(
      new IrregularBounds({ minX: -5.5, minY: -6.5, maxX: 0, maxY: 0 })
    )
  })

  it('keeps the other exact orthogonal rotations and negative rotations deterministic', async () => {
    const source = collisionGeometry([point(0, 0), point(6.5, 0), point(0, 5.5)])

    const [unrotated, halfTurn, clockwiseQuarterTurn] = await Promise.all([
      runCollisionTransform({ geometry: source, transform: transformCandidate({ rotationDeg: 0 }) }),
      runCollisionTransform({ geometry: source, transform: transformCandidate({ rotationDeg: 180 }) }),
      runCollisionTransform({ geometry: source, transform: transformCandidate({ rotationDeg: -90 }) })
    ])

    expect(unrotated.polygon.points).toEqual([point(0, 0), point(6.5, 0), point(0, 5.5)])
    expect(halfTurn.polygon.points).toEqual([point(0, 0), point(-6.5, 0), point(0, -5.5)])
    expect(clockwiseQuarterTurn.polygon.points).toEqual([
      point(0, 0),
      point(0, -6.5),
      point(5.5, 0)
    ])
  })

  it('accepts one explicit non-orthogonal angle without enumerating other angles', async () => {
    const transformed = await runCollisionTransform({
      geometry: collisionGeometry([point(0, 0), point(2, 0), point(0, 2)]),
      transform: transformCandidate({ rotationDeg: 45 })
    })

    expect(transformed.polygon.points[0]).toEqual(point(0, 0))
    expect(transformed.polygon.points[1]?.x).toBeCloseTo(Math.SQRT2, 12)
    expect(transformed.polygon.points[1]?.y).toBeCloseTo(Math.SQRT2, 12)
    expect(transformed.polygon.points[2]?.x).toBeCloseTo(-Math.SQRT2, 12)
    expect(transformed.polygon.points[2]?.y).toBeCloseTo(Math.SQRT2, 12)
    expect(transformed.bounds.minX).toBeCloseTo(-Math.SQRT2, 12)
    expect(transformed.bounds.minY).toBe(0)
    expect(transformed.bounds.maxX).toBeCloseTo(Math.SQRT2, 12)
    expect(transformed.bounds.maxY).toBeCloseTo(Math.SQRT2, 12)
  })

  it('rejects a collision polygon that is not strictly convex', async () => {
    const failure = await Effect.runPromise(
      GeometryKernel.use((kernel) =>
        kernel.transformCollisionGeometry({
          geometry: collisionGeometry([
            point(0, 0),
            point(4, 0),
            point(2, 1),
            point(4, 3),
            point(0, 3)
          ]),
          transform: transformCandidate({ rotationDeg: 0 })
        })
      ).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => null
        }),
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live)
      )
    )

    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
    expect(failure?.message).toBe('polygon must be strictly convex with one consistent winding.')
  })
})
