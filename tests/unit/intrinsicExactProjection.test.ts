import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPlacedPiece,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransform,
  IrregularTransformCandidate
} from '@shared/irregular/domain.js'
import {
  analyzeIntrinsicProjectionConflicts,
  buildIntrinsicTransformCatalog,
  projectIntrinsicLayoutExactly,
  type IntrinsicFiniteTransform,
  type IntrinsicTransformCatalog,
  type IntrinsicTransformCatalogEntry
} from '../../src/workers/algorithm/irregular/intrinsicExactProjection.js'
import { assertCanonicalGridLegalLayout } from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { NfpIfpService } from '../../src/workers/irregular/services.js'
import { SheetSpec } from '@shared/domain/nesting.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
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

function transform(index: number, rotationDeg: number): IrregularTransformCandidate {
  return new IrregularTransformCandidate({
    index,
    rotationDeg,
    mirrored: false,
    reason: 'configured'
  })
}

function preparedRectangle(
  id: string,
  width: number,
  height: number,
  transforms: ReadonlyArray<IrregularTransformCandidate> = [transform(0, 0)]
): IrregularPreparedPiece {
  const points = rectanglePoints(width, height)
  const polygon = new IrregularPolygon({ points })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(id),
    source: sourcePiece(id),
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: PieceId.make(id),
      sourceBounds: bounds(points),
      sampledPoints: points,
      convexHull: polygon,
      collisionPolygon: polygon,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms
  })
}

function buildCatalog(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): Promise<IntrinsicTransformCatalog> {
  return Effect.runPromise(
    buildIntrinsicTransformCatalog(pieces).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live)
    )
  )
}

function placed(
  entry: IntrinsicTransformCatalogEntry,
  finiteTransform: IntrinsicFiniteTransform,
  x: number,
  y: number
): IrregularPlacedPiece {
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      pieceId: entry.pieceId,
      sourcePieceId: entry.preparedPiece.source.id,
      placementReference: entry.preparedPiece.collisionGeometry.placementReference,
      transform: new IrregularTransform({
        translateX: x,
        translateY: y,
        rotationDeg: finiteTransform.transform.rotationDeg,
        mirrored: finiteTransform.transform.mirrored
      })
    }),
    collisionGeometry: finiteTransform.geometry
  })
}

function catalogEntry(catalog: IntrinsicTransformCatalog, id: string): IntrinsicTransformCatalogEntry {
  const entry = catalog.entries.find(({ pieceId }) => pieceId === PieceId.make(id))
  if (entry === undefined) throw new Error(`missing catalog entry ${id}`)
  return entry
}

function finiteTransform(entry: IntrinsicTransformCatalogEntry, rotationDeg: number) {
  const selected = entry.transforms.find(
    ({ transform: candidate }) => candidate.rotationDeg === rotationDeg
  )
  if (selected === undefined) throw new Error(`missing transform ${rotationDeg}`)
  return selected
}

function project(
  input: Parameters<typeof projectIntrinsicLayoutExactly>[0],
  nfpLayer: Layer.Layer<NfpIfpService> = NfpIfpServiceLive
) {
  return Effect.runPromise(
    projectIntrinsicLayoutExactly(input).pipe(
      Effect.provide(GeometrySettings.Live),
      Effect.provide(nfpLayer)
    )
  )
}

describe('intrinsic exact projection', () => {
  it('builds a deterministic sheet-free finite transform catalog', async () => {
    const pieces = [
      preparedRectangle('wide', 3, 1, [transform(1, 90), transform(0, 0)]),
      preparedRectangle('square', 2, 2)
    ]

    const first = await buildCatalog(pieces)
    const second = await buildCatalog(pieces)

    expect(first.canonicalKey).toBe(second.canonicalKey)
    expect(first.entries.map(({ pieceId }) => pieceId)).toEqual([
      PieceId.make('wide'),
      PieceId.make('square')
    ])
    expect(first.entries[0]?.transforms.map(({ transform: candidate }) => candidate.index)).toEqual([
      0, 1
    ])
    expect(first.entries[0]?.transforms.map(({ canonicalLocalGeometryKey }) => canonicalLocalGeometryKey))
      .toHaveLength(2)
  })

  it('removes both endpoints of every exact conflict plus wall offenders and proves the remainder', async () => {
    const catalog = await buildCatalog([
      preparedRectangle('safe', 2, 2),
      preparedRectangle('conflict-a', 2, 2),
      preparedRectangle('conflict-b', 2, 2),
      preparedRectangle('wall', 1, 1)
    ])
    const layout = [
      placed(catalogEntry(catalog, 'safe'), finiteTransform(catalogEntry(catalog, 'safe'), 0), 0, 0),
      placed(
        catalogEntry(catalog, 'conflict-a'),
        finiteTransform(catalogEntry(catalog, 'conflict-a'), 0),
        4,
        4
      ),
      placed(
        catalogEntry(catalog, 'conflict-b'),
        finiteTransform(catalogEntry(catalog, 'conflict-b'), 0),
        5.999,
        4
      ),
      placed(catalogEntry(catalog, 'wall'), finiteTransform(catalogEntry(catalog, 'wall'), 0), 9.5, 0)
    ]

    const analysis = await Effect.runPromise(
      analyzeIntrinsicProjectionConflicts({ widthMm: 10, heightMm: 10 }, layout)
    )

    expect(analysis.structure.positiveAreaConflictMeasurements).toContainEqual({
      pair: [PieceId.make('conflict-a'), PieceId.make('conflict-b')],
      areaMm2: 0.002
    })
    expect(analysis.removedPieceIds).toEqual([
      PieceId.make('conflict-a'),
      PieceId.make('conflict-b'),
      PieceId.make('wall')
    ])
    expect(analysis.frozenPlaced.map(({ placement }) => placement.pieceId)).toEqual([
      PieceId.make('safe')
    ])
    expect(analysis.frozenRemainderExactLegal).toBe(true)
  })

  it('uses a legal direct provisional pose and is independent of any requested sheet', async () => {
    const catalog = await buildCatalog([
      preparedRectangle('wide', 3, 1, [transform(0, 0), transform(1, 90)])
    ])
    const entry = catalogEntry(catalog, 'wide')
    const reference = [placed(entry, finiteTransform(entry, 0), 0, 0)]
    const provisional = [placed(entry, finiteTransform(entry, 90), 1.0001, 1.0001)]

    const first = await project({
      targetBox: { widthMm: 10, heightMm: 10 },
      catalog,
      referencePlaced: reference,
      provisionalPlaced: provisional
    })
    const sameCanonicalTarget = await project({
      targetBox: { widthMm: 10.0001, heightMm: 10.0001 },
      catalog,
      referencePlaced: reference,
      provisionalPlaced: provisional
    })

    expect(first.directPosePieceIds).toEqual([PieceId.make('wide')])
    expect(first.orientationFallbackPieceIds).toEqual([])
    expect(first.placedCollisionGeometries[0]?.placement.transform).toMatchObject({
      translateX: 1,
      translateY: 1,
      rotationDeg: 90
    })
    expect(first.canonicalGeometryIdentity).toBe(sameCanonicalTarget.canonicalGeometryIdentity)
  })

  it('falls back by orientation family only when the pinned transform has no legal candidate', async () => {
    const catalog = await buildCatalog([
      preparedRectangle('wide', 3, 1, [transform(0, 0), transform(1, 90)])
    ])
    const entry = catalogEntry(catalog, 'wide')
    const pinned = placed(entry, finiteTransform(entry, 0), 0, 0)

    const result = await project({
      targetBox: { widthMm: 2, heightMm: 4 },
      catalog,
      referencePlaced: [pinned],
      provisionalPlaced: [pinned]
    })

    expect(result.orientationFallbackPieceIds).toEqual([PieceId.make('wide')])
    expect(result.placedCollisionGeometries[0]?.placement.transform.rotationDeg).toBe(90)
    expect(
      assertCanonicalGridLegalLayout(
        new SheetSpec({ width: 2, height: 4, label: 'assertion only' }),
        result.placedCollisionGeometries
      )
    ).toBe(true)
  })

  it('projects a multi-conflict closure to one complete exact layout', async () => {
    const catalog = await buildCatalog([
      preparedRectangle('a', 2, 2),
      preparedRectangle('b', 2, 2),
      preparedRectangle('c', 2, 2),
      preparedRectangle('d', 2, 2)
    ])
    const provisional = [
      placed(catalogEntry(catalog, 'a'), finiteTransform(catalogEntry(catalog, 'a'), 0), 0, 0),
      placed(catalogEntry(catalog, 'b'), finiteTransform(catalogEntry(catalog, 'b'), 0), 1.999, 0),
      placed(catalogEntry(catalog, 'c'), finiteTransform(catalogEntry(catalog, 'c'), 0), 3.998, 0),
      placed(catalogEntry(catalog, 'd'), finiteTransform(catalogEntry(catalog, 'd'), 0), 6, 0)
    ]

    const result = await project({
      targetBox: { widthMm: 8, heightMm: 4 },
      catalog,
      referencePlaced: provisional,
      provisionalPlaced: provisional
    })

    expect(result.initialRemovedPieceIds).toEqual([
      PieceId.make('a'),
      PieceId.make('b'),
      PieceId.make('c')
    ])
    expect(result.placedCollisionGeometries).toHaveLength(4)
    expect(
      assertCanonicalGridLegalLayout(
        new SheetSpec({ width: 8, height: 4, label: 'assertion only' }),
        result.placedCollisionGeometries
      )
    ).toBe(true)
  })

  it('dilates the closure after a failed reinsertion instead of aborting immediately', async () => {
    const catalog = await buildCatalog([
      preparedRectangle('wall', 2, 2),
      preparedRectangle('frozen', 2, 2)
    ])
    const wallEntry = catalogEntry(catalog, 'wall')
    const frozenEntry = catalogEntry(catalog, 'frozen')
    const provisional = [
      placed(wallEntry, finiteTransform(wallEntry, 0), 4, 0),
      placed(frozenEntry, finiteTransform(frozenEntry, 0), 0, 0)
    ]
    const service = Layer.succeed(NfpIfpService, {
      computeNfp: () => Effect.die('unused'),
      computeIfpBounds: () => Effect.die('unused'),
      generatePlacementCandidates: ({ moving, placed: fixed }) => {
        const candidateX =
          fixed.length === 0 ? 0 : moving.sourcePieceId === PieceId.make('frozen') ? 2 : undefined
        return Effect.succeed(
          candidateX === undefined
            ? []
            : [
                new IrregularPlacementCandidate({
                  pieceId: moving.sourcePieceId,
                  transform: moving.transform,
                  point: point(candidateX, 0),
                  diagnostics: []
                })
              ]
        )
      }
    })

    const result = await project(
      {
        targetBox: { widthMm: 4, heightMm: 2 },
        catalog,
        referencePlaced: provisional,
        provisionalPlaced: provisional,
        maximumDilationSteps: 1
      },
      service
    )

    expect(result.dilationSteps).toBe(1)
    expect(result.finalRemovedPieceIds).toEqual([
      PieceId.make('wall'),
      PieceId.make('frozen')
    ])
    expect(result.placedCollisionGeometries).toHaveLength(2)
  })

  it('rejects a rounded positive overlap and returns a typed exhausted failure', async () => {
    const catalog = await buildCatalog([
      preparedRectangle('frozen', 2, 2),
      preparedRectangle('wall', 2, 2)
    ])
    const frozenEntry = catalogEntry(catalog, 'frozen')
    const wallEntry = catalogEntry(catalog, 'wall')
    const provisional = [
      placed(frozenEntry, finiteTransform(frozenEntry, 0), 0, 0),
      placed(wallEntry, finiteTransform(wallEntry, 0), 4, 0)
    ]
    const overlappingService = Layer.succeed(NfpIfpService, {
      computeNfp: () => Effect.die('unused'),
      computeIfpBounds: () => Effect.die('unused'),
      generatePlacementCandidates: ({ moving }) =>
        Effect.succeed([
          new IrregularPlacementCandidate({
            pieceId: moving.sourcePieceId,
            transform: moving.transform,
            point: point(1.999, 0),
            diagnostics: []
          })
        ])
    })

    await expect(
      project(
        {
          targetBox: { widthMm: 4, heightMm: 2 },
          catalog,
          referencePlaced: provisional,
          provisionalPlaced: provisional,
          maximumDilationSteps: 0
        },
        overlappingService
      )
    ).rejects.toMatchObject({
      _tag: 'IntrinsicExactProjectionError',
      operation: 'projectConflictClosure',
      category: 'projection-exhausted',
      failedPieceId: PieceId.make('wall')
    })
  })
})
