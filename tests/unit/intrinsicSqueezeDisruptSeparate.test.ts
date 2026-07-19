import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { NestingRequest, SheetSpec } from '@shared/domain/nesting.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPlacement,
  IrregularPlacedPiece,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularPriorityOrderKey,
  IrregularTransform,
  IrregularTransformCandidate,
  type IrregularNestingSettings
} from '@shared/irregular/domain.js'
import {
  deriveIntrinsicGlobalOrdinalSeed,
  deriveIntrinsicGlobalTargetRoles,
  INTRINSIC_GLOBAL_SEARCH_DEFAULTS,
  partitionIntrinsicStructuralPieces,
  retainIntrinsicInfeasiblePool,
  retainIntrinsicStructuralHandoffs,
  runIntrinsicSqueezeDisruptSeparateWithSchedule,
  type IntrinsicGlobalSearchSchedule,
  type IntrinsicInfeasiblePoolEntry,
  type IntrinsicStructuralHandoff
} from '../../src/workers/algorithm/irregular/intrinsicSqueezeDisruptSeparate.js'
import {
  dedupeIntrinsicRelaxedStates,
  evaluateIntrinsicSeparation,
  intrinsicDisruptionProposals,
  intrinsicFocusedProposals,
  intrinsicRelaxedStateKey,
  provisionalLayoutFromRelaxedState,
  relaxedStateFromExactLayout,
  remapIntrinsicTransformsQuarterTurn,
  transportIntrinsicGroup
} from '../../src/workers/algorithm/irregular/intrinsicTransformSeparator.js'
import {
  buildIntrinsicTransformCatalog,
  IntrinsicExactProjectionError,
  type IntrinsicExactProjectionResult,
  type IntrinsicTransformCatalog,
  type IntrinsicTransformCatalogEntry
} from '../../src/workers/algorithm/irregular/intrinsicExactProjection.js'
import { sortPiecesForNesting } from '../../src/workers/algorithm/sortPiecesForNesting.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import {
  IrregularNfpIfpControlAbortError,
  TransformGenerator
} from '../../src/workers/irregular/services.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'
import { analyzeCanonicalLayoutStructure } from '../../src/workers/irregular/canonicalLayoutGeometry.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
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
  transforms: ReadonlyArray<IrregularTransformCandidate> = [transform(0, 0)],
  origin = { x: 0, y: 0 }
): IrregularPreparedPiece {
  const points = [
    point(origin.x, origin.y),
    point(origin.x + width, origin.y),
    point(origin.x + width, origin.y + height),
    point(origin.x, origin.y + height)
  ]
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

function bounds(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  return new IrregularBounds({
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y))
  })
}

async function catalogFor(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): Promise<IntrinsicTransformCatalog> {
  return Effect.runPromise(
    buildIntrinsicTransformCatalog(pieces).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live)
    )
  )
}

function catalogEntry(
  catalog: IntrinsicTransformCatalog,
  id: string
): IntrinsicTransformCatalogEntry {
  const entry = catalog.entries.find(({ pieceId }) => pieceId === PieceId.make(id))
  if (entry === undefined) throw new Error(`missing catalog entry ${id}`)
  return entry
}

function placed(
  entry: IntrinsicTransformCatalogEntry,
  rotationDeg: number,
  x: number,
  y: number
): IrregularPlacedPiece {
  const finite = entry.transforms.find(({ transform: candidate }) => candidate.rotationDeg === rotationDeg)
  if (finite === undefined) throw new Error(`missing transform ${rotationDeg}`)
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      pieceId: entry.pieceId,
      sourcePieceId: entry.preparedPiece.source.id,
      placementReference: entry.preparedPiece.collisionGeometry.placementReference,
      transform: new IrregularTransform({
        translateX: x,
        translateY: y,
        rotationDeg,
        mirrored: false
      })
    }),
    collisionGeometry: finite.geometry
  })
}

function schedule(overrides: Partial<IntrinsicGlobalSearchSchedule> = {}): IntrinsicGlobalSearchSchedule {
  return {
    expectedStructuralPieceCount: 2,
    sweepsPerBasin: 1,
    forcedDisruptionSweeps: [0],
    poolCapacity: 8,
    maximumSeparationEvaluations: 2_000,
    maximumProjectionAttempts: 5,
    maximumRuntimeMs: 20_000,
    structuralHandoffCapacity: 5,
    explorationAreaCapMm2: 10,
    maximumCavityCount: 2,
    maximumLargestHullGapRatio: 0.15,
    seed: 1234,
    ...overrides
  }
}

function exactProjection(
  placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
): IntrinsicExactProjectionResult {
  return {
    placedCollisionGeometries,
    canonicalGeometryIdentity: 'mock-identity',
    initialRemovedPieceIds: [],
    finalRemovedPieceIds: [],
    transformedPieceIds: [],
    directPosePieceIds: [],
    orientationFallbackPieceIds: [],
    dilationSteps: 0
  }
}

function runController(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  e1: ReadonlyArray<IrregularPlacedPiece>,
  controllerSchedule: IntrinsicGlobalSearchSchedule,
  project: (input: {
    readonly provisionalPlaced: ReadonlyArray<IrregularPlacedPiece>
  }) => Effect.Effect<IntrinsicExactProjectionResult, IntrinsicExactProjectionError>,
  control?: Parameters<typeof runIntrinsicSqueezeDisruptSeparateWithSchedule>[0]['control']
) {
  return Effect.runPromise(
    runIntrinsicSqueezeDisruptSeparateWithSchedule(
      {
        allPreparedPieces: pieces,
        fullE1Placed: e1,
        ...(control === undefined ? {} : { control })
      },
      controllerSchedule,
      { project }
    ).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

describe('intrinsic global squeeze, disrupt, separate controller', () => {
  it('pins the registered five-projection schedule', () => {
    expect(INTRINSIC_GLOBAL_SEARCH_DEFAULTS.maximumProjectionAttempts).toBe(5)
  })

  it('lets a finite transform proposal change an overlapping topology', async () => {
    const pieces = [
      preparedRectangle('wide', 4, 1, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('block', 2, 2)
    ]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'wide'), 0, 0, 0),
      placed(catalogEntry(catalog, 'block'), 0, 0, 0)
    ])
    if (state === undefined) throw new Error('state expected')
    const evaluation = evaluateIntrinsicSeparation({ widthMm: 8, heightMm: 8 }, catalog, state)
    if (evaluation === undefined) throw new Error('evaluation expected')
    const proposals = intrinsicFocusedProposals({
      targetBox: { widthMm: 8, heightMm: 8 },
      catalog,
      state,
      evaluation,
      weights: { byConflictKey: new Map() },
      ordinal: 0
    })

    expect(evaluation.conflicts.some(({ kind }) => kind === 'pair')).toBe(true)
    expect(proposals.some(({ kind }) => kind === 'transform')).toBe(true)
    expect(new Set(proposals.map(({ state: next }) => intrinsicRelaxedStateKey(catalog, next))).size)
      .toBe(proposals.length)
  })

  it('builds q90 as one rigid world-layout turn and rejects unavailable asymmetric geometry', async () => {
    const pieces = [
      preparedRectangle('asymmetric', 4, 1, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('symmetric', 2, 2, [transform(0, 0)])
    ]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'asymmetric'), 0, 3, 5),
      placed(catalogEntry(catalog, 'symmetric'), 0, 10, 1)
    ])
    if (state === undefined) throw new Error('state expected')
    const rotated = remapIntrinsicTransformsQuarterTurn(catalog, state)
    if (rotated === undefined) throw new Error('rigid q90 expected')
    const before = provisionalLayoutFromRelaxedState(catalog, state) ?? []
    const after = provisionalLayoutFromRelaxedState(catalog, rotated) ?? []

    expect(worldLayoutPointSet(after)).toEqual(rigidQ90WorldPointSet(before))
    expect(
      after.find(({ placement }) => placement.pieceId === PieceId.make('symmetric'))?.placement
        .transform.rotationDeg
    ).toBe(0)

    const unavailablePieces = [preparedRectangle('only-zero', 4, 1, [transform(0, 0)])]
    const unavailableCatalog = await catalogFor(unavailablePieces)
    const unavailableState = relaxedStateFromExactLayout(unavailableCatalog, [
      placed(catalogEntry(unavailableCatalog, 'only-zero'), 0, 0, 0)
    ])
    expect(
      unavailableState === undefined
        ? undefined
        : remapIntrinsicTransformsQuarterTurn(unavailableCatalog, unavailableState)
    ).toBeUndefined()
  })

  it('skips unavailable q90 basins while completing every canonical q0 role', async () => {
    const pieces = [
      preparedRectangle('a', 2, 1, [transform(0, 0)]),
      preparedRectangle('b', 2, 1, [transform(0, 0)])
    ]
    const catalog = await catalogFor(pieces)
    const e1 = [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 2, 0)
    ]
    const result = await runController(
      pieces,
      e1,
      schedule(),
      ({ provisionalPlaced }) => Effect.succeed(exactProjection(provisionalPlaced))
    )

    expect(result.status).toBe('completed')
    expect(result.searchedBasinCount).toBe(3)
    expect(result.unavailableQuarterTurnBasinCount).toBe(3)
    expect(result.completedSweepCount).toBe(3)
    expect(result.projectionAttemptCount).toBe(2)
    expect(result.projectionTrace).toHaveLength(2)
    expect(result.trace).toHaveLength(3)
    expect(result.trace.every(({ basinIndex }) => basinIndex === 0)).toBe(true)
  })

  it('uses GLS weights to change the conflict selected for focused proposals', async () => {
    const pieces = [preparedRectangle('left', 2, 2), preparedRectangle('right', 2, 2)]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'left'), 0, 8, 0),
      placed(catalogEntry(catalog, 'right'), 0, 0, 8)
    ])
    if (state === undefined) throw new Error('state expected')
    const target = { widthMm: 8, heightMm: 8 }
    const evaluation = evaluateIntrinsicSeparation(target, catalog, state)
    if (evaluation === undefined) throw new Error('evaluation expected')
    const topConflict = evaluation.conflicts[0]
    const alternate = evaluation.conflicts.find(({ key }) => key !== topConflict?.key)
    if (topConflict === undefined || alternate === undefined) throw new Error('two conflicts expected')
    const defaultProposals = intrinsicFocusedProposals({
      targetBox: target,
      catalog,
      state,
      evaluation,
      weights: { byConflictKey: new Map() },
      ordinal: 1
    })
    const reweightedProposals = intrinsicFocusedProposals({
      targetBox: target,
      catalog,
      state,
      evaluation,
      weights: { byConflictKey: new Map([[alternate.key, 1_000]]) },
      ordinal: 1
    })

    expect(defaultProposals[0]?.affectedPieceIds).not.toEqual(
      reweightedProposals[0]?.affectedPieceIds
    )
  })

  it('transports negative-extent transforms by world-center delta and deduplicates the pool', async () => {
    const pieces = [
      preparedRectangle('offset', 4, 2, [transform(0, 0), transform(1, 90)], { x: -3, y: -1 }),
      preparedRectangle('anchor', 1, 1)
    ]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'offset'), 90, 5, 6),
      placed(catalogEntry(catalog, 'anchor'), 0, 0, 0)
    ])
    if (state === undefined) throw new Error('state expected')
    const moved = transportIntrinsicGroup(catalog, state, [PieceId.make('offset')], {
      x: 700,
      y: -300
    })
    if (moved === undefined) throw new Error('transport expected')
    const before = provisionalLayoutFromRelaxedState(catalog, state)?.[0]
    const after = provisionalLayoutFromRelaxedState(catalog, moved)?.[0]
    if (before === undefined || after === undefined) throw new Error('placements expected')
    expect(worldCenter(after).x - worldCenter(before).x).toBeCloseTo(0.7, 6)
    expect(worldCenter(after).y - worldCenter(before).y).toBeCloseTo(-0.3, 6)
    expect(dedupeIntrinsicRelaxedStates(catalog, [moved, state, moved, state], 8)).toHaveLength(2)
    expect(
      dedupeIntrinsicRelaxedStates(catalog, [state, moved], 8).map((entry) =>
        intrinsicRelaxedStateKey(catalog, entry)
      )
    ).toEqual(
      dedupeIntrinsicRelaxedStates(catalog, [moved, state], 8).map((entry) =>
        intrinsicRelaxedStateKey(catalog, entry)
      )
    )
  })

  it('prefers a structurally distinct large swap and adds a split squeeze', async () => {
    const pieces = [
      preparedRectangle('large-a', 10, 5, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('large-copy', 10, 5, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('distinct', 9, 4)
    ]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'large-a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'large-copy'), 90, 20, 0),
      placed(catalogEntry(catalog, 'distinct'), 0, 45, 0)
    ])
    if (state === undefined) throw new Error('state expected')
    const proposals = intrinsicDisruptionProposals({
      targetBox: { widthMm: 80, heightMm: 30 },
      catalog,
      state,
      ordinal: 2
    })
    const swap = proposals.find(({ kind }) => kind === 'swap')
    const squeeze = proposals.find(({ kind }) => kind === 'split-squeeze')

    expect(swap?.affectedPieceIds).toEqual([PieceId.make('large-a'), PieceId.make('distinct')])
    expect(squeeze?.affectedPieceIds).toHaveLength(3)
    if (squeeze === undefined) throw new Error('split squeeze expected')
    const originalSpan = occupiedSpan(provisionalLayoutFromRelaxedState(catalog, state) ?? [])
    const squeezedSpan = occupiedSpan(
      provisionalLayoutFromRelaxedState(catalog, squeeze.state) ?? []
    )
    expect(squeezedSpan.width).toBeLessThan(originalSpan.width)

    const identicalPieces = [
      preparedRectangle('copy-a', 10, 5, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('copy-b', 10, 5, [transform(0, 0), transform(1, 90)])
    ]
    const identicalCatalog = await catalogFor(identicalPieces)
    const identicalState = relaxedStateFromExactLayout(identicalCatalog, [
      placed(catalogEntry(identicalCatalog, 'copy-a'), 0, 0, 0),
      placed(catalogEntry(identicalCatalog, 'copy-b'), 90, 20, 0)
    ])
    if (identicalState === undefined) throw new Error('identical state expected')
    expect(
      intrinsicDisruptionProposals({
        targetBox: { widthMm: 50, heightMm: 20 },
        catalog: identicalCatalog,
        state: identicalState,
        ordinal: 4
      }).some(({ kind }) => kind === 'swap')
    ).toBe(false)
  })

  it('targets a gap-adjacent piece for exact-state interface disruption', async () => {
    const pieces = [
      preparedRectangle('left', 2, 8),
      preparedRectangle('top', 8, 2),
      preparedRectangle('right', 2, 8),
      preparedRectangle('far', 2, 2)
    ]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'left'), 0, 0, 0),
      placed(catalogEntry(catalog, 'top'), 0, 2, 6),
      placed(catalogEntry(catalog, 'right'), 0, 10, 0),
      placed(catalogEntry(catalog, 'far'), 0, 14, 0)
    ])
    if (state === undefined) throw new Error('state expected')
    const targetBox = { widthMm: 20.123, heightMm: 12.456 }
    const proposal = intrinsicDisruptionProposals({
      targetBox,
      catalog,
      state,
      ordinal: 3
    }).find(({ kind }) => kind === 'interface-disrupt')

    expect(proposal).toBeDefined()
    expect(proposal?.affectedPieceIds).toEqual([PieceId.make('left')])
    expect(intrinsicRelaxedStateKey(catalog, proposal?.state ?? state)).not.toBe(
      intrinsicRelaxedStateKey(catalog, state)
    )
    const analysisSheet = new SheetSpec({ width: 21, height: 13, label: 'gap-test' })
    const before = analyzeCanonicalLayoutStructure(
      analysisSheet,
      provisionalLayoutFromRelaxedState(catalog, state) ?? []
    )
    const after = analyzeCanonicalLayoutStructure(
      analysisSheet,
      provisionalLayoutFromRelaxedState(catalog, proposal?.state ?? state) ?? []
    )
    expect(after?.largestHullGap?.areaMm2).not.toBe(before?.largestHullGap?.areaMm2)
  })

  it('floors registered target boxes under the cap without a requested sheet input', async () => {
    const pieces = [preparedRectangle('envelope', 649.972, 644.576)]
    const catalog = await catalogFor(pieces)
    const roles = deriveIntrinsicGlobalTargetRoles([
      placed(catalogEntry(catalog, 'envelope'), 0, 0, 0)
    ])

    expect(roles?.map(({ widthMm, heightMm }) => [widthMm, heightMm])).toEqual([
      [649.972, 644.576],
      [666.023, 660.493],
      [765.858, 574.393]
    ])
    expect(roles?.every(({ areaMm2 }) => areaMm2 <= 439_904.17)).toBe(true)
  })

  it('keeps a non-dominated exact archive while removing dominated geometry', () => {
    const first = structuralHandoff('first', { envelopeAreaMm2: 8, totalStructuralContacts: 2 })
    const dominated = structuralHandoff('dominated', {
      envelopeAreaMm2: 9,
      totalStructuralContacts: 1
    })
    const tradeoff = structuralHandoff('tradeoff', {
      envelopeAreaMm2: 7,
      totalStructuralContacts: 1
    })

    expect(
      retainIntrinsicStructuralHandoffs([dominated, first, tradeoff], 5).map(
        ({ metrics }) => metrics.canonicalGeometryIdentity
      )
    ).toEqual(['tradeoff', 'first'])
  })

  it('protects forced disruption and newly weighted GLS lanes inside width eight', async () => {
    const pieces = [preparedRectangle('a', 1, 1), preparedRectangle('b', 1, 1)]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 2, 0)
    ])
    if (state === undefined) throw new Error('state expected')
    const hot = poolEntry(state, 'raw-hot', 1, 'hot', 1, undefined)
    const weightedAlternative = poolEntry(state, 'weighted-alternative', 1.2, 'cold', 1.2, undefined)
    const disruption = poolEntry(state, 'forced-disruption', 10, 'other', 10, 1)
    const retained = retainIntrinsicInfeasiblePool(
      [hot, weightedAlternative, disruption],
      8,
      { byConflictKey: new Map([['hot', 100]]) },
      0
    )

    expect(retained[0]?.key).toBe('raw-hot')
    expect(retained.some(({ key }) => key === 'weighted-alternative')).toBe(true)
    expect(retained.some(({ key }) => key === 'forced-disruption')).toBe(true)
    expect(
      retained.find(({ key }) => key === 'raw-hot')?.evaluation.weightedLoss
    ).toBe(100)
    expect(
      retainIntrinsicInfeasiblePool(
        [hot, weightedAlternative, disruption],
        2,
        { byConflictKey: new Map() },
        2
      ).some(({ key }) => key === 'forced-disruption')
    ).toBe(false)
  })

  it('returns exact E1 on an incomplete budget and propagates cancellation before projection', async () => {
    const pieces = [
      preparedRectangle('a', 2, 1, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('b', 2, 1, [transform(0, 0), transform(1, 90)])
    ]
    const catalog = await catalogFor(pieces)
    const e1 = [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 2, 0)
    ]
    const fallback = await runController(
      pieces,
      e1,
      schedule({ maximumSeparationEvaluations: 0 }),
      ({ provisionalPlaced }) => Effect.succeed(exactProjection(provisionalPlaced))
    )

    expect(fallback.status).toBe('budget-fallback')
    expect(fallback.fullE1Fallback).toEqual(e1)
    expect(fallback.structuralHandoffs).toEqual([])
    expect(fallback.searchedBasinCount).toBe(0)
    expect(fallback.separationEvaluationCount).toBe(0)

    await expect(
      runController(
        pieces,
        e1,
        schedule({ sweepsPerBasin: 0 }),
        ({ provisionalPlaced }) => Effect.succeed(exactProjection(provisionalPlaced)),
        {
          checkpoint: () =>
            Effect.fail(
              new IrregularNfpIfpControlAbortError({
                reason: 'cancelled',
                message: 'cancelled by test'
              })
            )
        }
      )
    ).rejects.toMatchObject({ _tag: 'IrregularNfpIfpControlAbortError', reason: 'cancelled' })

    await expect(
      runController(
        pieces,
        e1,
        schedule({ maximumRuntimeMs: 0 }),
        ({ provisionalPlaced }) => Effect.succeed(exactProjection(provisionalPlaced)),
        {
          checkpoint: () =>
            Effect.fail(
              new IrregularNfpIfpControlAbortError({
                reason: 'cancelled',
                message: 'simultaneous cancellation wins'
              })
            )
        }
      )
    ).rejects.toMatchObject({ _tag: 'IrregularNfpIfpControlAbortError', reason: 'cancelled' })
  })

  it('rejects an exact fallback that replaces a prepared filler with a foreign piece', async () => {
    const pieces = [
      preparedRectangle('large-a', 4, 4, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('large-b', 4, 4, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('filler', 1, 1)
    ]
    const foreign = preparedRectangle('foreign', 1, 1)
    const catalog = await catalogFor([...pieces, foreign])
    const invalidFallback = [
      placed(catalogEntry(catalog, 'large-a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'large-b'), 0, 4, 0),
      placed(catalogEntry(catalog, 'foreign'), 0, 8, 0)
    ]

    await expect(
      runController(
        pieces,
        invalidFallback,
        schedule(),
        ({ provisionalPlaced }) => Effect.succeed(exactProjection(provisionalPlaced))
      )
    ).rejects.toMatchObject({
      _tag: 'IntrinsicGlobalSearchError',
      operation: 'initialize'
    })
  })

  it('derives ordinals from canonical sheetless job identity and the fixed schedule seed', async () => {
    const firstJob = [
      preparedRectangle('a', 2, 1, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('b', 3, 2, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('filler', 0.5, 0.5)
    ]
    const reorderedCatalog = await catalogFor([...firstJob].reverse())
    const firstCatalog = await catalogFor(firstJob)
    const differentCatalog = await catalogFor([
      preparedRectangle('a', 2, 1, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('b', 3, 2, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('filler', 0.75, 0.5)
    ])

    const firstSeed = deriveIntrinsicGlobalOrdinalSeed(firstCatalog, schedule().seed)
    expect(deriveIntrinsicGlobalOrdinalSeed(reorderedCatalog, schedule().seed)).toBe(firstSeed)
    expect(deriveIntrinsicGlobalOrdinalSeed(firstCatalog, schedule().seed)).toBe(firstSeed)
    expect(deriveIntrinsicGlobalOrdinalSeed(differentCatalog, schedule().seed)).not.toBe(firstSeed)
  })

  it('owns the E1 fallback and schedule before hostile cooperative checkpoints', async () => {
    const pieces = [
      preparedRectangle('a', 2, 1, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('b', 2, 1, [transform(0, 0), transform(1, 90)])
    ]
    const catalog = await catalogFor(pieces)
    const mutableE1 = [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 2, 0)
    ]
    const forcedDisruptionSweeps = [0]
    const mutableSchedule = {
      ...schedule(),
      forcedDisruptionSweeps
    }
    let mutated = false
    const result = await runController(
      pieces,
      mutableE1,
      mutableSchedule,
      ({ provisionalPlaced }) => Effect.succeed(exactProjection(provisionalPlaced)),
      {
        checkpoint: () => {
          if (!mutated) {
            mutated = true
            mutableE1.splice(0, mutableE1.length)
            forcedDisruptionSweeps.splice(0, forcedDisruptionSweeps.length)
            mutableSchedule.sweepsPerBasin = 0
            mutableSchedule.maximumProjectionAttempts = 0
          }
          return Effect.void
        }
      }
    )

    expect(result.status).toBe('completed')
    expect(result.fullE1Fallback).toHaveLength(2)
    expect(result.completedSweepCount).toBe(6)
    expect(result.projectionAttemptCount).toBe(5)
    expect(result.trace.filter(({ forcedDisruption }) => forcedDisruption)).toHaveLength(6)
  })

  it('is same-seed deterministic and reports exact projection/quality outcomes separately', async () => {
    const pieces = [
      preparedRectangle('a', 2, 1, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('b', 2, 1, [transform(0, 0), transform(1, 90)])
    ]
    const catalog = await catalogFor(pieces)
    const e1 = [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 2, 0)
    ]
    const controllerSchedule = schedule()
    const project = ({ provisionalPlaced }: { readonly provisionalPlaced: ReadonlyArray<IrregularPlacedPiece> }) =>
      Effect.succeed(exactProjection(provisionalPlaced))
    const first = await runController(pieces, e1, controllerSchedule, project)
    const second = await runController(pieces, e1, controllerSchedule, project)

    expect(first.status).toBe('completed')
    expect(first.trace).toEqual(second.trace)
    expect(first.projectionTrace).toEqual(second.projectionTrace)
    expect(first.structuralHandoffs.length).toBeGreaterThan(0)
    expect(first.structuralHandoffs).toEqual(second.structuralHandoffs)
    expect(first.searchedBasinCount).toBe(6)
    expect(first.unavailableQuarterTurnBasinCount).toBe(0)
    expect(first.completedSweepCount).toBe(6)
    expect(first.projectionAttemptCount).toBe(5)
    expect(first.projectionTrace).toHaveLength(5)
    expect(first.separationEvaluationCount).toBeLessThanOrEqual(
      controllerSchedule.maximumSeparationEvaluations
    )

    const overlapProject = ({ provisionalPlaced }: { readonly provisionalPlaced: ReadonlyArray<IrregularPlacedPiece> }) => {
      const firstPlaced = provisionalPlaced[0]
      const secondPlaced = provisionalPlaced[1]
      if (firstPlaced === undefined || secondPlaced === undefined) throw new Error('two placements expected')
      return Effect.succeed(
        exactProjection([
          firstPlaced,
          movePlaced(secondPlaced, firstPlaced.placement.transform.translateX, firstPlaced.placement.transform.translateY)
        ])
      )
    }
    const rejected = await runController(pieces, e1, controllerSchedule, overlapProject)
    expect(rejected.structuralHandoffs).toEqual([])
    expect(rejected.projectionTrace.every(({ outcome }) => outcome === 'quality-rejected')).toBe(true)

    const exhausted = await runController(
      pieces,
      e1,
      controllerSchedule,
      () =>
        Effect.fail(
          new IntrinsicExactProjectionError({
            operation: 'projectConflictClosure',
            category: 'projection-exhausted',
            message: 'synthetic exhaustion',
            failedPieceId: PieceId.make('a'),
            attempts: 2
          })
        )
    )
    expect(exhausted.projectionSuccessCount).toBe(0)
    expect(
      exhausted.projectionTrace.every(
        ({ outcome, failedPieceId, dilationSteps }) =>
          outcome === 'projection-exhausted' &&
          failedPieceId === PieceId.make('a') &&
          dilationSteps === 2
      )
    ).toBe(true)
  })

  it('preserves the mixed-61 E3 area-threshold partition contract at 53/8', async () => {
    const fixturePath = fileURLToPath(
      new URL('../fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
    )
    const request = Schema.decodeUnknownSync(NestingRequest)(
      JSON.parse(readFileSync(fixturePath, 'utf8'))
    )
    const settings = request.options.irregularSettings
    if (settings === undefined) throw new Error('mixed-61 settings expected')
    const pieces = await Effect.runPromise(withPreparationLayers(prepareMixedPieces(request, settings), settings))
    const partition = partitionIntrinsicStructuralPieces(pieces)

    expect(pieces).toHaveLength(61)
    expect(partition?.structuralPieces).toHaveLength(53)
    expect(partition?.fillerPieces).toHaveLength(8)
  }, 30_000)
})

function worldCenter(entry: IrregularPlacedPiece): { readonly x: number; readonly y: number } {
  const points = entry.collisionGeometry.polygon.points.map((point) => ({
    x: point.x + entry.placement.transform.translateX,
    y: point.y + entry.placement.transform.translateY
  }))
  return {
    x: (Math.min(...points.map(({ x }) => x)) + Math.max(...points.map(({ x }) => x))) / 2,
    y: (Math.min(...points.map(({ y }) => y)) + Math.max(...points.map(({ y }) => y))) / 2
  }
}

function occupiedSpan(placedEntries: ReadonlyArray<IrregularPlacedPiece>) {
  const points = placedEntries.flatMap((entry) =>
    entry.collisionGeometry.polygon.points.map((point) => ({
      x: point.x + entry.placement.transform.translateX,
      y: point.y + entry.placement.transform.translateY
    }))
  )
  return {
    width: Math.max(...points.map(({ x }) => x)) - Math.min(...points.map(({ x }) => x)),
    height: Math.max(...points.map(({ y }) => y)) - Math.min(...points.map(({ y }) => y))
  }
}

function worldLayoutPointSet(
  placedEntries: ReadonlyArray<IrregularPlacedPiece>
): ReadonlyArray<string> {
  return placedEntries
    .flatMap((entry) =>
      entry.collisionGeometry.polygon.points.map((point) => ({
        pieceId: entry.placement.pieceId ?? entry.placement.sourcePieceId,
        x: Math.round((point.x + entry.placement.transform.translateX) * 1_000),
        y: Math.round((point.y + entry.placement.transform.translateY) * 1_000)
      }))
    )
    .map(({ pieceId, x, y }) => `${pieceId}:${x}:${y}`)
    .toSorted()
}

function rigidQ90WorldPointSet(
  placedEntries: ReadonlyArray<IrregularPlacedPiece>
): ReadonlyArray<string> {
  const rotated = placedEntries.flatMap((entry) =>
    entry.collisionGeometry.polygon.points.map((point) => ({
      pieceId: entry.placement.pieceId ?? entry.placement.sourcePieceId,
      x: -Math.round((point.y + entry.placement.transform.translateY) * 1_000),
      y: Math.round((point.x + entry.placement.transform.translateX) * 1_000)
    }))
  )
  const minimumX = Math.min(...rotated.map(({ x }) => x))
  const minimumY = Math.min(...rotated.map(({ y }) => y))
  return rotated
    .map(({ pieceId, x, y }) => `${pieceId}:${x - minimumX}:${y - minimumY}`)
    .toSorted()
}

function poolEntry(
  state: IntrinsicInfeasiblePoolEntry['state'],
  key: string,
  rawLoss: number,
  conflictKey: string,
  normalizedDepthSquared: number,
  disruptionProtectedUntilSweep: number | undefined
): IntrinsicInfeasiblePoolEntry {
  const normalizedDepth = Math.sqrt(normalizedDepthSquared)
  return {
    state,
    key,
    disruptionProtectedUntilSweep,
    evaluation: {
      rawLoss,
      weightedLoss: rawLoss,
      exactZeroLoss: false,
      conflicts: [
        {
          key: conflictKey,
          kind: 'wall',
          firstPieceId: PieceId.make('a'),
          secondPieceId: undefined,
          rawDepth: normalizedDepth,
          normalizedDepth,
          moveXGrid: 1,
          moveYGrid: 0
        }
      ]
    }
  }
}

function structuralHandoff(
  identity: string,
  overrides: Partial<IntrinsicStructuralHandoff['metrics']>
): IntrinsicStructuralHandoff {
  return {
    targetRoleId: 'e1-envelope',
    basinIndex: 0,
    projectionAttempt: 1,
    placedCollisionGeometries: [],
    metrics: {
      canonicalGeometryIdentity: identity,
      enclosedCavityCount: 0,
      totalEnclosedCavityAreaMm2: 0,
      largestOccupiedHullGapRatio: 0.1,
      envelopeAreaMm2: 10,
      envelopeMaximumSideMm: 4,
      envelopeSpanMm: 7,
      occupiedHullWasteRatio: 0.1,
      totalStructuralContacts: 1,
      dominantStructuralContacts: 1,
      ...overrides
    }
  }
}

function movePlaced(entry: IrregularPlacedPiece, x: number, y: number): IrregularPlacedPiece {
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      ...entry.placement,
      transform: new IrregularTransform({
        ...entry.placement.transform,
        translateX: x,
        translateY: y
      })
    }),
    collisionGeometry: entry.collisionGeometry
  })
}

function withPreparationLayers<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  settings: IrregularNestingSettings
) {
  return effect.pipe(
    Effect.provide(GeometryKernel.Live),
    Effect.provide(CollisionGeometryBuilder.Live),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(Layer.succeed(GeometrySettings, settings))
  )
}

function prepareMixedPieces(
  request: NestingRequest,
  settings: IrregularNestingSettings
): Effect.Effect<
  ReadonlyArray<IrregularPreparedPiece>,
  unknown,
  CollisionGeometryBuilder | TransformGenerator
> {
  return Effect.gen(function* () {
    const geometryBuilder = yield* CollisionGeometryBuilder
    const transformGenerator = yield* TransformGenerator
    const sourcePieces = request.sourcePieces ?? []
    const result: IrregularPreparedPiece[] = []
    for (const prepared of sortPiecesForNesting(request.pieces)) {
      const source = sourcePieces.find((candidate) => {
        const sourceBase = prepared.sourcePieceId.replace(/-copy-\d+$/, '')
        const preparedBase = prepared.id.replace(/-copy-\d+$/, '')
        return (
          candidate.id === prepared.sourcePieceId ||
          candidate.id === prepared.id ||
          candidate.id === sourceBase ||
          candidate.id === preparedBase
        )
      })
      if (source === undefined) throw new Error(`missing source ${prepared.sourcePieceId}`)
      const collisionGeometry = yield* geometryBuilder.buildPiece({
        piece: source,
        totalPaddingMm: request.padding
      })
      const allowMirror =
        (request.options.allowGlobalMirror ?? true) && (prepared.allowMirror ?? true)
      const transforms = yield* transformGenerator.generateTransforms({
        geometry: collisionGeometry,
        allowRotation: request.options.allowGlobalRotation && prepared.allowRotation,
        allowMirror,
        settings: settings.optimizer
      })
      result.push(
        new IrregularPreparedPiece({
          pieceId: prepared.id,
          interchangeabilityKey: prepared.interchangeabilityKey ?? prepared.id,
          source,
          allowMirror,
          collisionGeometry,
          transforms,
          priorityOrderKey: new IrregularPriorityOrderKey({
            longSideMm: prepared.paddedBounds.longestEdge,
            areaMm2: prepared.paddedBounds.area,
            imbalanceMm: prepared.paddedBounds.imbalance
          })
        })
      )
    }
    return result
  })
}
