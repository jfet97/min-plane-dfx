import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError
} from '../../src/workers/irregular/services.js'
import {
  IrregularBounds,
  IrregularGeometrySettings,
  IrregularNestingSettings,
  IrregularPoint,
  IrregularPolygon
} from '@shared/irregular/domain.js'
import { DxfGeometrySummary, ImportedPiece, ImportWarning } from '@shared/domain/dxf.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { Rect } from '@shared/domain/geometry.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function rectanglePiece(input?: {
  readonly id?: string
  readonly closed?: boolean
  readonly warnings?: ReadonlyArray<ImportWarning>
}): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make(input?.id ?? 'offset-rectangle'),
    sourceFileId: SourceFileId.make('test-source'),
    label: 'Offset rectangle',
    realBounds: new Rect({ x: 10, y: 20, width: 4, height: 3 }),
    geometry: new DxfGeometrySummary({
      entityType: 'LWPOLYLINE',
      closed: input?.closed ?? true,
      segments: [
        { kind: 'line', x1: 10, y1: 20, x2: 14, y2: 20 },
        { kind: 'line', x1: 14, y1: 20, x2: 14, y2: 23 },
        { kind: 'line', x1: 14, y1: 23, x2: 10, y2: 23 },
        { kind: 'line', x1: 10, y1: 23, x2: 10, y2: 20 }
      ]
    }),
    warnings: [...(input?.warnings ?? [])]
  })
}

function circlePiece(): ImportedPiece {
  const arcs = [0, 90, 180, 270].map((startAngle) => {
    const endAngle = startAngle + 90
    const startRadians = (startAngle * Math.PI) / 180
    const endRadians = (endAngle * Math.PI) / 180
    return {
      kind: 'arc' as const,
      x1: 50 + Math.cos(startRadians) * 50,
      y1: 50 + Math.sin(startRadians) * 50,
      x2: 50 + Math.cos(endRadians) * 50,
      y2: 50 + Math.sin(endRadians) * 50,
      cx: 50,
      cy: 50,
      radius: 50,
      startAngle,
      endAngle
    }
  })
  return new ImportedPiece({
    id: PieceId.make('offset-circle'),
    sourceFileId: SourceFileId.make('circle-source'),
    label: 'Circle',
    realBounds: new Rect({ x: 0, y: 0, width: 100, height: 100 }),
    geometry: new DxfGeometrySummary({ entityType: 'CIRCLE', closed: true, segments: arcs }),
    warnings: []
  })
}

function runBuildPiece(input: { readonly piece: ImportedPiece; readonly totalPaddingMm: number }) {
  return Effect.runPromise(
    CollisionGeometryBuilder.use((builder) => builder.buildPiece(input)).pipe(
      Effect.provide(CollisionGeometryBuilder.Live),
      Effect.provide(GeometrySettings.Live)
    )
  )
}

function runBuildPieceWithSettings(
  input: { readonly piece: ImportedPiece; readonly totalPaddingMm: number },
  settings: IrregularGeometrySettings
) {
  return Effect.runPromise(
    CollisionGeometryBuilder.use((builder) => builder.buildPiece(input)).pipe(
      Effect.provide(CollisionGeometryBuilder.Layer),
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

describe('CollisionGeometryBuilder', () => {
  it('builds an imported full circle whose closing samples share one quantized point', async () => {
    const geometry = await runBuildPiece({ piece: circlePiece(), totalPaddingMm: 10 })

    expect(geometry.sampledPoints.length).toBeGreaterThan(4)
    expect(geometry.collisionPolygon.points.length).toBeGreaterThan(4)
  })

  it('preserves source samples while producing a normalized padded collision polygon', async () => {
    const warning = new ImportWarning({
      code: 'source_note',
      message: 'The source outline was grouped from multiple DXF entities.'
    })

    const geometry = await runBuildPiece({
      piece: rectanglePiece({ warnings: [warning] }),
      totalPaddingMm: 2
    })

    expect(geometry.sourceBounds).toEqual(
      new IrregularBounds({ minX: 10, minY: 20, maxX: 14, maxY: 23 })
    )
    expect(geometry.placementReference).toEqual(point(8.748, 18.748))
    expect(geometry.sampledPoints).toEqual([
      point(10, 20),
      point(14, 20),
      point(14, 23),
      point(10, 23)
    ])
    expect(geometry.convexHull).toEqual(
      new IrregularPolygon({
        points: [
          point(1.252, 1.252),
          point(5.252, 1.252),
          point(5.252, 4.252),
          point(1.252, 4.252)
        ]
      })
    )
    expect(geometry.collisionPolygon).toEqual(
      new IrregularPolygon({
        points: [point(0, 0), point(6.504, 0), point(6.504, 5.504), point(0, 5.504)]
      })
    )
    expect(geometry.diagnostics).toEqual([
      {
        code: 'source_note',
        message: 'The source outline was grouped from multiple DXF entities.',
        pieceId: PieceId.make('offset-rectangle')
      }
    ])
  })

  it('uses the geometry settings service when deriving the collision offset', async () => {
    const settings = new IrregularGeometrySettings({
      flatteningSagToleranceMm: 0.25,
      clearanceSafetyMarginMm: 0.5,
      geometryBackendId: 'test-geometry-backend',
      geometryBackendVersion: 'settings-proof'
    })

    const geometry = await runBuildPieceWithSettings(
      { piece: rectanglePiece(), totalPaddingMm: 2 },
      settings
    )

    expect(geometry.collisionPolygon.points).toEqual([
      point(0, 0),
      point(7.004, 0),
      point(7.004, 6.004),
      point(0, 6.004)
    ])
  })

  it('keeps the supplied piece order when building a batch', async () => {
    const pieces = await Effect.runPromise(
      CollisionGeometryBuilder.use((builder) =>
        builder.buildPieces([
          { piece: rectanglePiece({ id: 'first-piece' }), totalPaddingMm: 0 },
          { piece: rectanglePiece({ id: 'second-piece' }), totalPaddingMm: 0 }
        ])
      ).pipe(
        Effect.provide(CollisionGeometryBuilder.Live),
        Effect.provide(GeometrySettings.Live)
      )
    )

    expect(pieces.map((piece) => piece.sourcePieceId)).toEqual([
      PieceId.make('first-piece'),
      PieceId.make('second-piece')
    ])
  })

  it('rejects an open source path instead of pretending it encloses material', async () => {
    const failure = await Effect.runPromise(
      CollisionGeometryBuilder.use((builder) =>
        builder.buildPiece({ piece: rectanglePiece({ closed: false }), totalPaddingMm: 2 })
      ).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => null
        }),
        Effect.provide(CollisionGeometryBuilder.Live),
        Effect.provide(GeometrySettings.Live)
      )
    )

    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
    expect(failure?.operation).toBe('buildCollisionGeometry')
    expect(failure?.message).toBe(
      'offset-rectangle: source geometry must be a closed outline before collision geometry can be built.'
    )
  })

  it('keeps Unimplemented independent from GeometryKernel and GeometrySettings', async () => {
    const failure = await Effect.runPromise(
      CollisionGeometryBuilder.use((builder) =>
        builder.buildPiece({ piece: rectanglePiece(), totalPaddingMm: 2 })
      ).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => null
        }),
        Effect.provide(CollisionGeometryBuilder.Unimplemented)
      )
    )

    expect(failure).toBeInstanceOf(IrregularNestingNotImplementedError)
    expect(failure?.message).toBe(
      'CollisionGeometryBuilder.buildPiece is intentionally unimplemented.'
    )
  })
})
