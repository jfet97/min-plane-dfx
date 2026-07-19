import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransformCandidate
} from '@shared/irregular/domain.js'
import {
  enumerateIntrinsicPeriodicCells,
  expandIntrinsicPeriodicCell
} from '../../src/workers/algorithm/irregular/intrinsicPeriodicCells.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function preparedPiece(
  id: string,
  family: string,
  points: ReadonlyArray<IrregularPoint>
): IrregularPreparedPiece {
  const polygon = new IrregularPolygon({ points })
  const source = new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`source-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width: 1, height: 1 }),
    geometry: new DxfGeometrySummary({ entityType: 'PRESET_SHAPE', closed: true, segments: [] }),
    warnings: []
  })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(id),
    interchangeabilityKey: family,
    source,
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: source.id,
      sourceBounds: new IrregularBounds({
        minX: Math.min(...points.map(({ x }) => x)),
        minY: Math.min(...points.map(({ y }) => y)),
        maxX: Math.max(...points.map(({ x }) => x)),
        maxY: Math.max(...points.map(({ y }) => y))
      }),
      sampledPoints: points,
      convexHull: polygon,
      collisionPolygon: polygon,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms: [0, 90].map(
      (rotationDeg, index) =>
        new IrregularTransformCandidate({
          index,
          rotationDeg,
          mirrored: false,
          reason: 'configured'
        })
    )
  })
}

function runCatalog(pieces: ReadonlyArray<IrregularPreparedPiece>) {
  return Effect.runPromise(
    enumerateIntrinsicPeriodicCells(pieces).pipe(
      Effect.provide(GeometryKernel.Live.pipe(Layer.provide(GeometrySettings.Live))),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

describe('intrinsic periodic cells', () => {
  it('rejects the dense rectangle lattice when the strict far-neighbor certificate is equal', async () => {
    const pieces = Array.from({ length: 6 }, (_, index) =>
      preparedPiece(`rectangle-${index}`, 'rectangle', [
        point(0, 0),
        point(4, 0),
        point(4, 2),
        point(0, 2)
      ])
    )
    const catalog = await runCatalog(pieces)
    expect(catalog.selectedFamilyKey).toContain('rectangle')
    expect(catalog.uniqueTransformCount).toBe(2)
    expect(catalog.cells).toEqual([])
    expect(catalog.rejected.noP1Basis).toBe(2)
  })

  it('keeps a triangle-like repeated family source-linked and exact', async () => {
    const pieces = Array.from({ length: 4 }, (_, index) =>
      preparedPiece(`triangle-${index}`, 'triangle-like', [point(0, 0), point(4, 0), point(0, 2)])
    )
    const catalog = await runCatalog(pieces)
    expect(catalog.selectedFamilyKey).toContain('triangle-like')
    expect(catalog.cells.every(({ determinantGrid2 }) => determinantGrid2 > 0)).toBe(true)
    for (const seed of catalog.cells) {
      const expanded = await Effect.runPromise(expandIntrinsicPeriodicCell(seed, pieces))
      expect(
        expanded[0]?.placements.every(({ placement }) => placement.pieceId !== undefined)
      ).toBe(true)
    }
  })
})
