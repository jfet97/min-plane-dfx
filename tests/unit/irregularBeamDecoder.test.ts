import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IRREGULAR_NESTING_SETTINGS
} from '@shared/irregular/defaults.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPoint,
  IrregularPolygon,
  IrregularPlacementCandidate,
  IrregularPreparedPiece,
  IrregularTransformCandidate,
  IrregularTransform
} from '@shared/irregular/domain.js'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { Rect } from '@shared/domain/geometry.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import { GeometryKernel } from '../../src/workers/irregular/geometryKernel.js'
import { decodeStrictPriorityOrder } from '../../src/workers/algorithm/irregular/strictPriorityDecoder.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import {
  IrregularGeometryInfeasibleError,
  IrregularGeometryInputError,
  NfpIfpService
} from '../../src/workers/irregular/services.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function polygon(points: ReadonlyArray<IrregularPoint>): IrregularPolygon {
  return new IrregularPolygon({ points })
}

function squarePoints(size: number): ReadonlyArray<IrregularPoint> {
  return rectanglePoints(size, size)
}

function rectanglePoints(width: number, height: number): ReadonlyArray<IrregularPoint> {
  return [point(0, 0), point(width, 0), point(width, height), point(0, height)]
}

function bounds(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  return new IrregularBounds({
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y))
  })
}

function sourcePiece(id: string): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`source-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width: 1, height: 1 }),
    geometry: new DxfGeometrySummary({ entityType: 'PRESET_SHAPE', closed: true, segments: [] }),
    warnings: []
  })
}

function collisionGeometry(
  id: string,
  points: ReadonlyArray<IrregularPoint>
): CollisionGeometry {
  const shape = polygon(points)
  return new CollisionGeometry({
    sourcePieceId: PieceId.make(id),
    sourceBounds: bounds(points),
    sampledPoints: points,
    convexHull: shape,
    collisionPolygon: shape,
    placementReference: point(0, 0),
    diagnostics: []
  })
}

function transform(
  index: number,
  rotationDeg = 0,
  mirrored = false,
  reason: IrregularTransformCandidate['reason'] = 'configured'
): IrregularTransformCandidate {
  return new IrregularTransformCandidate({
    index,
    rotationDeg,
    mirrored,
    reason
  })
}

function preparedPiece(
  id: string,
  points: ReadonlyArray<IrregularPoint>,
  transforms: ReadonlyArray<IrregularTransformCandidate>
): IrregularPreparedPiece {
  return new IrregularPreparedPiece({
    source: sourcePiece(id),
    allowMirror: true,
    collisionGeometry: collisionGeometry(id, points),
    transforms
  })
}

function sheet(width: number, height: number): SheetSpec {
  return new SheetSpec({ width, height, label: 'decoder test sheet' })
}

function decode(
  currentSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>
) {
  return Effect.runPromise(
    decodeStrictPriorityOrder(currentSheet, pieces, DEFAULT_IRREGULAR_NESTING_SETTINGS).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

function metadataReasonRank(reason: IrregularTransformCandidate['reason']): number {
  if (reason === 'configured') return 0
  if (reason === 'edge_alignment') return 1
  return 2
}

function decodeWithEqualCandidatePoints(
  currentSheet: SheetSpec,
  transforms: ReadonlyArray<IrregularTransformCandidate>
) {
  const candidateService = Layer.succeed(NfpIfpService, {
    computeNfp: () => Effect.die('unused in metadata tie-break test'),
    computeIfpBounds: () => Effect.die('unused in metadata tie-break test'),
    generatePlacementCandidates: ({ moving, placed }) => {
      const firstPlaced = placed[0]
      const candidatePoint =
        firstPlaced === undefined
          ? point(0, 0)
          : point(
              firstPlaced.collisionGeometry.transform.index,
              firstPlaced.collisionGeometry.transform.rotationDeg +
                Number(firstPlaced.collisionGeometry.transform.mirrored) / 10 +
                metadataReasonRank(firstPlaced.collisionGeometry.transform.reason) / 100
            )

      return Effect.succeed([
        new IrregularPlacementCandidate({
          pieceId: moving.sourcePieceId,
          transform: moving.transform,
          point: candidatePoint,
          diagnostics: []
        })
      ])
    }
  })

  return Effect.runPromise(
    decodeStrictPriorityOrder(currentSheet, [
      preparedPiece('metadata-tie', squarePoints(2), transforms),
      preparedPiece('metadata-marker', squarePoints(1), [transform(0)])
    ], DEFAULT_IRREGULAR_NESTING_SETTINGS).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(candidateService)
    )
  )
}

describe('decodeStrictPriorityOrder', () => {
  it('preserves the supplied priority order and places real polygons without positive overlap', async () => {
    const pieces = [
      preparedPiece('priority-second', squarePoints(3), [transform(0)]),
      preparedPiece('priority-first', squarePoints(3), [transform(0)])
    ]

    const result = await decode(sheet(10, 4), pieces)

    expect(result.unplacedPieceIds).toEqual([])
    expect(result.placements.map(({ sourcePieceId }) => sourcePieceId)).toEqual([
      PieceId.make('priority-second'),
      PieceId.make('priority-first')
    ])
    expect(result.placements.map(({ transform }) => [transform.translateX, transform.translateY])).toEqual([
      [0, 0],
      [3, 0]
    ])
  })

  it('continues after a blocked piece and attempts a later piece', async () => {
    const pieces = [
      preparedPiece('blocking', squarePoints(6), [transform(0)]),
      preparedPiece('impossible', squarePoints(5), [transform(0)]),
      preparedPiece('later', squarePoints(2), [transform(0)])
    ]

    const result = await decode(sheet(10, 6), pieces)

    expect(result.unplacedPieceIds).toEqual([PieceId.make('impossible')])
    expect(result.placements.map(({ sourcePieceId }) => sourcePieceId)).toEqual([
      PieceId.make('blocking'),
      PieceId.make('later')
    ])
    expect(result.placements[1]?.transform.translateX).toBe(6)
    expect(result.placements[1]?.transform.translateY).toBe(0)
  })

  it('tries the next transform when an earlier transformed polygon cannot fit', async () => {
    const piece = preparedPiece('transform-fit', rectanglePoints(6, 2), [
      transform(0),
      transform(1, 90)
    ])

    const withoutFallback = await decode(sheet(4, 8), [
      preparedPiece('transform-fit-only-zero', rectanglePoints(6, 2), [transform(0)])
    ])
    expect(withoutFallback.unplacedPieceIds).toEqual([PieceId.make('transform-fit-only-zero')])

    const withFallback = await decode(sheet(4, 8), [piece])
    expect(withFallback.unplacedPieceIds).toEqual([])
    expect(withFallback.placements[0]?.transform).toEqual(
      new IrregularTransform({
        translateX: 2,
        translateY: 0,
        rotationDeg: 90,
        mirrored: false
      })
    )
  })

  it('surfaces a valid but sheet-infeasible transform as a distinct typed error', async () => {
    const moving = await Effect.runPromise(
      GeometryKernel.use((kernel) =>
        kernel.transformCollisionGeometry({
          geometry: collisionGeometry('infeasible', rectanglePoints(6, 2)),
          transform: transform(0)
        })
      ).pipe(Effect.provide(GeometryKernel.Live))
    )

    const failure = await Effect.runPromise(
      NfpIfpService.use((service) =>
        service.computeIfpBounds({ sheet: sheet(4, 8), moving })
      ).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => undefined
        }),
        Effect.provide(NfpIfpServiceLive)
      )
    )

    expect(failure).toBeInstanceOf(IrregularGeometryInfeasibleError)
    if (!(failure instanceof IrregularGeometryInfeasibleError))
      throw new Error('expected infeasible geometry error')
    expect(failure._tag).toBe('IrregularGeometryInfeasibleError')
  })

  it('uses reversed metadata ties in index, rotation, mirror, and reason order', async () => {
    const cases: ReadonlyArray<{
      readonly transforms: ReadonlyArray<IrregularTransformCandidate>
      readonly markerPoint: IrregularPoint
    }> = [
      {
        transforms: [transform(2), transform(1)],
        markerPoint: point(1, 0)
      },
      {
        transforms: [transform(1, 90), transform(1, 0)],
        markerPoint: point(1, 0)
      },
      {
        transforms: [transform(1, 0, true), transform(1, 0, false)],
        markerPoint: point(1, 0)
      },
      {
        transforms: [transform(1, 0, false, 'orthogonal'), transform(1, 0, false, 'configured')],
        markerPoint: point(1, 0)
      }
    ]

    for (const { transforms, markerPoint } of cases) {
      const result = await decodeWithEqualCandidatePoints(sheet(10, 10), transforms)

      expect(result.placements[0]?.transform).toEqual(
        new IrregularTransform({
          translateX: 0,
          translateY: 0,
          rotationDeg: 0,
          mirrored: false
        })
      )
      expect(result.placements[1]?.transform).toEqual(
        new IrregularTransform({
          translateX: markerPoint.x,
          translateY: markerPoint.y,
          rotationDeg: 0,
          mirrored: false
        })
      )
    }
  })

  it('propagates an invalid collision polygon as a typed geometry error', async () => {
    const invalidPiece = preparedPiece('invalid', [
      point(0, 0),
      point(4, 0),
      point(2, 1),
      point(4, 4),
      point(0, 4)
    ], [transform(0)])

    const failure = await Effect.runPromise(
      decodeStrictPriorityOrder(sheet(10, 10), [invalidPiece], DEFAULT_IRREGULAR_NESTING_SETTINGS).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => undefined
        }),
        Effect.provide(GeometryKernel.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )

    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
    if (!(failure instanceof IrregularGeometryInputError)) throw new Error('expected geometry error')
    expect(failure.operation).toBe('transformCollisionGeometry')
  })
})
