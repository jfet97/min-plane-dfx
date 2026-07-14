import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { IrregularNestingNotImplementedError } from '../../src/workers/irregular/services.js'
import { IrregularGeometrySettings, IrregularPoint } from '@shared/irregular/domain.js'
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
      convexHullSimplificationToleranceMm: 0,
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
})
