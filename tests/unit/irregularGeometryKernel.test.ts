import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError
} from '../../src/workers/irregular/services.js'
import { IrregularGeometrySettings, IrregularPoint, IrregularPolygon } from '@shared/irregular/domain.js'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { Rect } from '@shared/domain/geometry.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function runConvexHull(points: ReadonlyArray<IrregularPoint>) {
  return Effect.runPromise(
    GeometryKernel.use((kernel) => kernel.convexHull(points)).pipe(
      Effect.provide(GeometryKernel.Live)
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
      Effect.provide(GeometryKernel.Live)
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
      Effect.provide(Layer.succeed(GeometrySettings, settings))
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
        Effect.provide(Layer.succeed(GeometrySettings, settings))
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

    expect(offset.points).toEqual([point(-1.5, -1.5), point(5.5, -1.5), point(5.5, 4.5), point(-1.5, 4.5)])
  })

  it('expands a clockwise polygon outward without changing its winding', async () => {
    const offset = await runConvexOffset({
      polygon: polygon([point(0, 0), point(0, 3), point(4, 3), point(4, 0)]),
      totalPaddingMm: 1.5
    })

    expect(offset.points).toEqual([point(-1, -1), point(-1, 4), point(5, 4), point(5, -1)])
  })

  it('computes mitred corners by intersecting adjacent shifted edge lines', async () => {
    const offset = await runConvexOffset({
      polygon: polygon([point(0, 0), point(4, 0), point(0, 3)]),
      totalPaddingMm: 1.5
    })

    expect(offset.points).toHaveLength(3)
    expect(offset.points[0]).toEqual(point(-1, -1))
    expect(offset.points[1]).toEqual(point(7, -1))
    expect(offset.points[2]?.x).toBeCloseTo(-1, 12)
    expect(offset.points[2]?.y).toBeCloseTo(5, 12)
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
        Effect.provide(GeometryKernel.Live)
      )
    )

    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
    expect(failure?.message).toBe('polygon must be strictly convex with one consistent winding.')
  })
})
