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
  compareIntrinsicProjectionGridDistance,
  projectIntrinsicLayoutExactly,
  type IntrinsicFiniteTransform,
  type IntrinsicTransformCatalog,
  type IntrinsicTransformCatalogEntry
} from '../../src/workers/algorithm/irregular/intrinsicExactProjection.js'
import { assertCanonicalGridLegalLayout } from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import {
  IrregularNfpIfpControlAbortError,
  NfpIfpService
} from '../../src/workers/irregular/services.js'
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

function catalogPriority(catalog: IntrinsicTransformCatalog): ReadonlyArray<PieceId> {
  return catalog.entries.map(({ pieceId }) => pieceId)
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

  it('orders extreme safe grid distances exactly before any subtraction', () => {
    const maximum = Number.MAX_SAFE_INTEGER
    const reference = { x: -maximum, y: maximum }
    const nearer = { x: maximum - 1, y: -maximum + 1 }
    const farther = { x: maximum, y: -maximum }

    expect(compareIntrinsicProjectionGridDistance(reference, nearer, farther)).toBe(-1)
    expect(compareIntrinsicProjectionGridDistance(reference, farther, nearer)).toBe(1)
    expect(compareIntrinsicProjectionGridDistance(reference, nearer, farther)).toBe(-1)
    expect(
      compareIntrinsicProjectionGridDistance(reference, { x: maximum + 1, y: 0 }, farther)
    ).toBeUndefined()
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
      provisionalPlaced: provisional,
      reinsertionPriorityPieceIds: catalogPriority(catalog)
    })
    const sameCanonicalTarget = await project({
      targetBox: { widthMm: 10.0001, heightMm: 10.0001 },
      catalog,
      referencePlaced: reference,
      provisionalPlaced: provisional,
      reinsertionPriorityPieceIds: catalogPriority(catalog)
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

  it('uses the required reinsertion priority for a multi-piece conflict closure', async () => {
    const catalog = await buildCatalog([
      preparedRectangle('a', 2, 2),
      preparedRectangle('b', 2, 2),
      preparedRectangle('c', 2, 2)
    ])
    const provisional = catalog.entries.map((entry) =>
      placed(entry, finiteTransform(entry, 0), 0, 0)
    )
    const attemptedPieceIds: PieceId[] = []
    const candidateXByPieceId = new Map<PieceId, number>([
      [PieceId.make('a'), 4],
      [PieceId.make('b'), 2],
      [PieceId.make('c'), 0]
    ])
    const service = Layer.succeed(NfpIfpService, {
      computeNfp: () => Effect.die('unused'),
      computeIfpBounds: () => Effect.die('unused'),
      generatePlacementCandidates: ({ moving }) => {
        attemptedPieceIds.push(moving.sourcePieceId)
        const x = candidateXByPieceId.get(moving.sourcePieceId)
        return Effect.succeed(
          x === undefined
            ? []
            : [
                new IrregularPlacementCandidate({
                  pieceId: moving.sourcePieceId,
                  transform: moving.transform,
                  point: point(x, 0),
                  diagnostics: []
                })
              ]
        )
      }
    })
    const priority = [PieceId.make('c'), PieceId.make('b'), PieceId.make('a')]

    const result = await project(
      {
        targetBox: { widthMm: 6, heightMm: 2 },
        catalog,
        referencePlaced: provisional,
        provisionalPlaced: provisional,
        reinsertionPriorityPieceIds: priority
      },
      service
    )

    expect(attemptedPieceIds).toEqual(priority)
    expect(result.initialRemovedPieceIds).toEqual(priority)
    expect(result.directPosePieceIds).toEqual([PieceId.make('c')])
    expect(result.placedCollisionGeometries.map(({ placement }) => placement.pieceId)).toEqual(
      priority
    )
  })

  it('keeps an owned priority snapshot when the caller mutates its array at a checkpoint', async () => {
    const catalog = await buildCatalog([
      preparedRectangle('a', 2, 2),
      preparedRectangle('b', 2, 2),
      preparedRectangle('c', 2, 2)
    ])
    const provisional = catalog.entries.map((entry) =>
      placed(entry, finiteTransform(entry, 0), 0, 0)
    )
    const priority = [PieceId.make('c'), PieceId.make('b'), PieceId.make('a')]
    const expectedPriority = [...priority]
    let mutated = false
    const service = Layer.succeed(NfpIfpService, {
      computeNfp: () => Effect.die('unused'),
      computeIfpBounds: () => Effect.die('unused'),
      generatePlacementCandidates: ({ moving }) => {
        const x =
          moving.sourcePieceId === PieceId.make('c')
            ? 0
            : moving.sourcePieceId === PieceId.make('b')
              ? 2
              : 4
        return Effect.succeed([
          new IrregularPlacementCandidate({
            pieceId: moving.sourcePieceId,
            transform: moving.transform,
            point: point(x, 0),
            diagnostics: []
          })
        ])
      }
    })

    const result = await project(
      {
        targetBox: { widthMm: 6, heightMm: 2 },
        catalog,
        referencePlaced: provisional,
        provisionalPlaced: provisional,
        reinsertionPriorityPieceIds: priority,
        control: {
          checkpoint: () => {
            if (!mutated) {
              priority.splice(
                0,
                priority.length,
                PieceId.make('a'),
                PieceId.make('a'),
                PieceId.make('a')
              )
              mutated = true
            }
            return Effect.void
          }
        }
      },
      service
    )

    expect(priority).toEqual([PieceId.make('a'), PieceId.make('a'), PieceId.make('a')])
    expect(result.initialRemovedPieceIds).toEqual(expectedPriority)
    expect(result.placedCollisionGeometries.map(({ placement }) => placement.pieceId)).toEqual(
      expectedPriority
    )
    expect(new Set(result.placedCollisionGeometries.map(({ placement }) => placement.pieceId)).size)
      .toBe(catalog.entries.length)
  })

  it.each([
    ['duplicate', [PieceId.make('a'), PieceId.make('a')]],
    ['missing', [PieceId.make('a')]],
    ['unknown', [PieceId.make('a'), PieceId.make('unknown')]]
  ])('rejects a %s reinsertion priority before projection', async (_name, priority) => {
    const catalog = await buildCatalog([
      preparedRectangle('a', 1, 1),
      preparedRectangle('b', 1, 1)
    ])
    const reference = catalog.entries.map((entry, index) =>
      placed(entry, finiteTransform(entry, 0), index, 0)
    )

    await expect(
      project({
        targetBox: { widthMm: 2, heightMm: 1 },
        catalog,
        referencePlaced: reference,
        provisionalPlaced: reference,
        reinsertionPriorityPieceIds: priority
      })
    ).rejects.toMatchObject({
      _tag: 'IntrinsicExactProjectionError',
      operation: 'canonicalizeProvisional',
      category: 'invalid-input',
      message:
        'reinsertionPriorityPieceIds must be an exact permutation of the transform catalog piece ids.'
    })
  })

  it('shares one candidate memo scope within a projection and isolates separate calls', async () => {
    const catalog = await buildCatalog([
      preparedRectangle('a', 2, 2),
      preparedRectangle('b', 2, 2)
    ])
    const provisional = catalog.entries.map((entry) =>
      placed(entry, finiteTransform(entry, 0), 0, 0)
    )
    const scopes: object[] = []
    const service = Layer.succeed(NfpIfpService, {
      computeNfp: () => Effect.die('unused'),
      computeIfpBounds: () => Effect.die('unused'),
      generatePlacementCandidates: ({ moving, candidateMemoScope }) => {
        if (candidateMemoScope !== undefined) scopes.push(candidateMemoScope)
        return Effect.succeed([
          new IrregularPlacementCandidate({
            pieceId: moving.sourcePieceId,
            transform: moving.transform,
            point: point(moving.sourcePieceId === PieceId.make('a') ? 0 : 2, 0),
            diagnostics: []
          })
        ])
      }
    })
    const input = {
      targetBox: { widthMm: 4, heightMm: 2 },
      catalog,
      referencePlaced: provisional,
      provisionalPlaced: provisional,
      reinsertionPriorityPieceIds: catalogPriority(catalog)
    }

    await project(input, service)
    await project(input, service)

    expect(scopes).toHaveLength(4)
    expect(scopes[0]).toBe(scopes[1])
    expect(scopes[2]).toBe(scopes[3])
    expect(scopes[0]).not.toBe(scopes[2])
  })

  it('propagates a typed cooperative abort between projection stages', async () => {
    const catalog = await buildCatalog([
      preparedRectangle('wide', 3, 1, [transform(0, 0), transform(1, 90)])
    ])
    const entry = catalogEntry(catalog, 'wide')
    const reference = [placed(entry, finiteTransform(entry, 0), 0, 0)]
    const provisional = [placed(entry, finiteTransform(entry, 90), 1, 1)]
    let checkpoints = 0

    await expect(
      project({
        targetBox: { widthMm: 10, heightMm: 10 },
        catalog,
        referencePlaced: reference,
        provisionalPlaced: provisional,
        reinsertionPriorityPieceIds: catalogPriority(catalog),
        control: {
          checkpoint: () => {
            checkpoints += 1
            return checkpoints === 2
              ? Effect.fail(
                  new IrregularNfpIfpControlAbortError({
                    reason: 'cancelled',
                    message: 'test projection cancellation'
                  })
                )
              : Effect.void
          }
        }
      })
    ).rejects.toMatchObject({
      _tag: 'IrregularNfpIfpControlAbortError',
      reason: 'cancelled'
    })
    expect(checkpoints).toBe(2)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite maximumDilationSteps %s before floor and clamp',
    async (maximumDilationSteps) => {
      const catalog = await buildCatalog([preparedRectangle('only', 2, 2)])
      const entry = catalogEntry(catalog, 'only')
      const reference = [placed(entry, finiteTransform(entry, 0), 0, 0)]

      await expect(
        project({
          targetBox: { widthMm: 4, heightMm: 4 },
          catalog,
          referencePlaced: reference,
          provisionalPlaced: reference,
          reinsertionPriorityPieceIds: catalogPriority(catalog),
          maximumDilationSteps
        })
      ).rejects.toMatchObject({
        _tag: 'IntrinsicExactProjectionError',
        operation: 'canonicalizeProvisional',
        category: 'invalid-input',
        message: 'maximumDilationSteps must be finite.'
      })
    }
  )

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
      provisionalPlaced: [pinned],
      reinsertionPriorityPieceIds: catalogPriority(catalog)
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
      provisionalPlaced: provisional,
      reinsertionPriorityPieceIds: catalogPriority(catalog)
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
        reinsertionPriorityPieceIds: catalogPriority(catalog),
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

  it('uses reinsertion priority to break an equidistant closure-dilation tie', async () => {
    const catalog = await buildCatalog([
      preparedRectangle('failed', 2, 2),
      preparedRectangle('left', 2, 2),
      preparedRectangle('right', 2, 2)
    ])
    const failedEntry = catalogEntry(catalog, 'failed')
    const leftEntry = catalogEntry(catalog, 'left')
    const rightEntry = catalogEntry(catalog, 'right')
    const provisional = [
      placed(failedEntry, finiteTransform(failedEntry, 0), 2, 2),
      placed(leftEntry, finiteTransform(leftEntry, 0), 0, 0),
      placed(rightEntry, finiteTransform(rightEntry, 0), 4, 0)
    ]
    const service = Layer.succeed(NfpIfpService, {
      computeNfp: () => Effect.die('unused'),
      computeIfpBounds: () => Effect.die('unused'),
      generatePlacementCandidates: ({ moving, placed: fixed }) => {
        const x =
          moving.sourcePieceId === PieceId.make('failed')
            ? fixed.length === 2
              ? undefined
              : 2
            : moving.sourcePieceId === PieceId.make('right')
              ? 4
              : 0
        return Effect.succeed(
          x === undefined
            ? []
            : [
                new IrregularPlacementCandidate({
                  pieceId: moving.sourcePieceId,
                  transform: moving.transform,
                  point: point(x, 0),
                  diagnostics: []
                })
              ]
        )
      }
    })

    const result = await project(
      {
        targetBox: { widthMm: 6, heightMm: 2 },
        catalog,
        referencePlaced: provisional,
        provisionalPlaced: provisional,
        reinsertionPriorityPieceIds: [
          PieceId.make('failed'),
          PieceId.make('right'),
          PieceId.make('left')
        ],
        maximumDilationSteps: 1
      },
      service
    )

    expect(result.dilationSteps).toBe(1)
    expect(result.finalRemovedPieceIds).toEqual([
      PieceId.make('failed'),
      PieceId.make('right')
    ])
    expect(result.placedCollisionGeometries).toHaveLength(3)
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
          reinsertionPriorityPieceIds: catalogPriority(catalog),
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
