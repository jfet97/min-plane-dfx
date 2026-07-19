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
  floorIntrinsicTargetGrid,
  inheritIntrinsicDisruptionLineage,
  INTRINSIC_GLOBAL_SEARCH_DEFAULTS,
  partitionIntrinsicStructuralPieces,
  retainIntrinsicInfeasiblePool,
  retainIntrinsicStructuralHandoffs,
  retainIntrinsicStructuralHandoffsWithDiagnostics,
  runIntrinsicSqueezeDisruptSeparateWithSchedule,
  selectIntrinsicProjectionWorkItems,
  type IntrinsicGlobalSearchSchedule,
  type IntrinsicGlobalTargetRole,
  type IntrinsicInfeasiblePoolEntry,
  type IntrinsicProjectionLaneCandidate,
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
  transportIntrinsicGroup,
  type IntrinsicSeparationEvaluation
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
    interfaceDisruptionMaximumCavityCount: 2,
    interfaceDisruptionMaximumHullGapRatio: 0.15,
    interfaceDisruptionStagnationSweeps: 2,
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

  it('lets a finite transform proposal change a wall-conflicted topology', async () => {
    const pieces = [
      preparedRectangle('wide', 4, 1, [transform(0, 0), transform(1, 90)])
    ]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'wide'), 0, 6, 0)
    ])
    if (state === undefined) throw new Error('state expected')
    const evaluation = evaluateIntrinsicSeparation({ widthMm: 3, heightMm: 8 }, catalog, state)
    if (evaluation === undefined) throw new Error('evaluation expected')
    const proposals = intrinsicFocusedProposals({
      catalog,
      state,
      evaluation,
      weights: { byConflictKey: new Map() }
    })

    expect(evaluation.conflicts.some(({ kind }) => kind === 'wall')).toBe(true)
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
    expect(result.projectionAttemptCount).toBe(
      result.projectionLaneTrace.filter(({ outcome }) => outcome === 'selected').length
    )
    expect(result.projectionTrace).toHaveLength(result.projectionAttemptCount)
    expect(result.projectionLaneTrace).toHaveLength(5)
    expect(result.trace).toHaveLength(3)
    expect(result.trace.every(({ basinIndex }) => basinIndex === 0)).toBe(true)
  })

  it('publishes an exact ringy structural projection for downstream filler evaluation', async () => {
    const transforms = [transform(0, 0), transform(1, 90)]
    const pieces = [
      preparedRectangle('bottom', 6, 1, transforms),
      preparedRectangle('top', 6, 1, transforms),
      preparedRectangle('left', 1, 4, transforms),
      preparedRectangle('right', 1, 4, transforms)
    ]
    const catalog = await catalogFor(pieces)
    const ring = [
      placed(catalogEntry(catalog, 'bottom'), 0, 0, 0),
      placed(catalogEntry(catalog, 'top'), 0, 0, 5),
      placed(catalogEntry(catalog, 'left'), 0, 0, 1),
      placed(catalogEntry(catalog, 'right'), 0, 5, 1)
    ]
    const result = await runController(
      pieces,
      ring,
      schedule({ expectedStructuralPieceCount: 4, explorationAreaCapMm2: 100 }),
      () => Effect.succeed(exactProjection(ring))
    )

    expect(result.status).toBe('completed')
    expect(result.structuralHandoffs.length).toBeGreaterThan(0)
    expect(
      result.structuralHandoffs.some(
        ({ metrics }) => metrics.largestOccupiedHullGapRatio > 0.15
      )
    ).toBe(true)
    expect(result.projectionTrace.every(({ outcome }) => outcome === 'exact-success')).toBe(true)
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
    const defaultProposals = intrinsicFocusedProposals({
      catalog,
      state,
      evaluation,
      weights: { byConflictKey: new Map() }
    })
    const defaultPieceId = defaultProposals[0]?.affectedPieceIds[0]
    const alternate = evaluation.conflicts.find(
      ({ firstPieceId, secondPieceId }) =>
        firstPieceId !== defaultPieceId && secondPieceId !== defaultPieceId
    )
    if (defaultPieceId === undefined || alternate === undefined) {
      throw new Error('independent weighted conflict expected')
    }
    const reweightedProposals = intrinsicFocusedProposals({
      catalog,
      state,
      evaluation,
      weights: { byConflictKey: new Map([[alternate.key, 1_000]]) }
    })

    expect(defaultProposals[0]?.affectedPieceIds).not.toEqual(
      reweightedProposals[0]?.affectedPieceIds
    )
  })

  it('selects the greatest summed weighted piece contribution, not one deepest conflict', async () => {
    const pieces = [preparedRectangle('aggregate', 1, 1), preparedRectangle('deepest', 1, 1)]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'aggregate'), 0, 0, 0),
      placed(catalogEntry(catalog, 'deepest'), 0, 2, 0)
    ])
    if (state === undefined) throw new Error('state expected')
    const aggregateId = PieceId.make('aggregate')
    const deepestId = PieceId.make('deepest')
    const evaluation: IntrinsicSeparationEvaluation = {
      rawLoss: 1.36,
      weightedLoss: 1.36,
      exactZeroLoss: false,
      conflicts: [
        syntheticWallConflict('aggregate-x', aggregateId, 0.6, 1, 0),
        syntheticWallConflict('aggregate-y', aggregateId, 0.6, 0, 1),
        syntheticWallConflict('deepest', deepestId, 0.8, -1, 0)
      ]
    }
    const proposals = intrinsicFocusedProposals({
      catalog,
      state,
      evaluation,
      weights: { byConflictKey: new Map() }
    })

    expect(proposals[0]?.affectedPieceIds).toEqual([aggregateId])
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
      ordinal: 2,
      maximumInterfaceCavityCount: 2,
      maximumInterfaceHullGapRatio: 0.15
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
        ordinal: 4,
        maximumInterfaceCavityCount: 2,
        maximumInterfaceHullGapRatio: 0.15
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
      ordinal: 3,
      maximumInterfaceCavityCount: 2,
      maximumInterfaceHullGapRatio: 0.15
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

  it('preserves exact grid roles and floors arbitrary millimeters conservatively', async () => {
    expect(floorIntrinsicTargetGrid(82.77)).toBe(82_770)
    expect(floorIntrinsicTargetGrid(82.7709)).toBe(82_770)
    expect(floorIntrinsicTargetGrid(82.7699)).toBe(82_769)
    for (const grid of [1, 17, 82_770, 649_972, 1_000_000]) {
      expect(floorIntrinsicTargetGrid(grid / 1_000)).toBe(grid)
    }
    const pieces = [preparedRectangle('grid-role', 82.77, 10.111)]
    const catalog = await catalogFor(pieces)
    const roles = deriveIntrinsicGlobalTargetRoles([
      placed(catalogEntry(catalog, 'grid-role'), 0, 0, 0)
    ])
    expect(roles?.[0]).toMatchObject({ widthMm: 82.77, heightMm: 10.111 })
  })

  it('inherits disruption lineage and ORs it during same-state deduplication', async () => {
    expect(inheritIntrinsicDisruptionLineage(false, 'swap')).toBe(true)
    expect(inheritIntrinsicDisruptionLineage(true, 'separate')).toBe(true)
    expect(inheritIntrinsicDisruptionLineage(false, 'separate')).toBe(false)

    const pieces = [preparedRectangle('a', 1, 1), preparedRectangle('b', 1, 1)]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 2, 0)
    ])
    if (state === undefined) throw new Error('state expected')
    const ordinary = poolEntry(state, 'same-state', 1, 'ordinary', 1, undefined)
    const disrupted = {
      ...poolEntry(state, 'same-state', 2, 'disrupted', 2, undefined),
      disruptionLineage: true
    }
    const retained = retainIntrinsicInfeasiblePool(
      [ordinary, disrupted],
      1,
      { byConflictKey: new Map() },
      1
    )

    expect(retained).toHaveLength(1)
    expect(retained[0]?.evaluation.rawLoss).toBe(1)
    expect(retained[0]?.disruptionLineage).toBe(true)
  })

  it('selects the deterministic five-lane projection portfolio without backfill', async () => {
    const pieces = [preparedRectangle('a', 1, 1), preparedRectangle('b', 1, 1)]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 2, 0)
    ])
    if (state === undefined) throw new Error('state expected')
    const roles = projectionTargetRoles()
    const candidates = [
      projectionLaneCandidate(roles[0], 0, state, 'raw', 1, 8, false),
      projectionLaneCandidate(roles[1], 0, state, 'gls', 2, 0.5, false),
      projectionLaneCandidate(roles[0], 1, state, 'e1-disruption', 3, 1, true),
      projectionLaneCandidate(roles[1], 1, state, 'expanded-disruption', 4, 1, true),
      projectionLaneCandidate(roles[2], 0, state, 'four-three-disruption', 5, 1, true)
    ]
    const first = selectIntrinsicProjectionWorkItems(candidates, roles)
    const second = selectIntrinsicProjectionWorkItems([...candidates].reverse(), roles)

    expect(first).toEqual(second)
    expect(first.workItems).toHaveLength(5)
    expect(first.workItems.map(({ lane }) => lane)).toEqual([
      'global-raw',
      'global-final-gls',
      'role-disruption',
      'role-disruption',
      'role-disruption'
    ])
    expect(first.trace.every(({ outcome }) => outcome === 'selected')).toBe(true)
  })

  it('reports unavailable and collapsed projection lanes without generic backfill', async () => {
    const pieces = [preparedRectangle('a', 1, 1), preparedRectangle('b', 1, 1)]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 2, 0)
    ])
    if (state === undefined) throw new Error('state expected')
    const roles = projectionTargetRoles()
    const candidates = [
      projectionLaneCandidate(roles[0], 0, state, 'raw', 1, 0.5, false),
      projectionLaneCandidate(roles[0], 1, state, 'e1-disruption', 2, 1, true),
      projectionLaneCandidate(roles[1], 0, state, 'collapsed', 3, 0.1, true)
    ]
    const selection = selectIntrinsicProjectionWorkItems(candidates, roles)

    expect(selection.workItems).toHaveLength(3)
    expect(selection.trace.map(({ outcome }) => outcome)).toEqual([
      'selected',
      'selected',
      'selected',
      'lane-collapsed',
      'lane-unavailable'
    ])
    expect(selection.trace[3]).toMatchObject({
      lane: 'role-disruption',
      requestedTargetRoleId: 'expanded-e1-envelope',
      collapsedIntoWorkIdentity: selection.workItems[1]?.workIdentity
    })
  })

  it('keeps canonically novel structural handoffs even when structurally dominated', () => {
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
    ).toEqual(['tradeoff', 'first', 'dominated'])
  })

  it('reports deterministic structural identity retention and capacity outcomes', () => {
    const original = structuralHandoff('same', { envelopeAreaMm2: 10 })
    const replacement = structuralHandoff('same', { envelopeAreaMm2: 8 })
    const discarded = structuralHandoff('same', { envelopeAreaMm2: 12 })
    const novel = structuralHandoff('novel', { envelopeAreaMm2: 7 })
    const pruned = structuralHandoff('pruned', { envelopeAreaMm2: 20 })
    const first = retainIntrinsicStructuralHandoffsWithDiagnostics(
      [original, replacement, discarded, novel, pruned],
      2
    )
    const second = retainIntrinsicStructuralHandoffsWithDiagnostics(
      [original, replacement, discarded, novel, pruned],
      2
    )

    expect(first).toEqual(second)
    expect(first.handoffs.map(({ metrics }) => metrics.canonicalGeometryIdentity)).toEqual([
      'novel',
      'same'
    ])
    expect(first.trace.map(({ outcome }) => outcome)).toEqual([
      'retained',
      'duplicate-replaced',
      'duplicate-discarded',
      'retained',
      'capacity-pruned'
    ])
    expect(first.trace[1]).toMatchObject({
      candidate: { canonicalGeometryIdentity: 'same', metrics: { envelopeAreaMm2: 8 } },
      representative: {
        canonicalGeometryIdentity: 'same',
        metrics: { envelopeAreaMm2: 8 }
      },
      pruned: { canonicalGeometryIdentity: 'same', metrics: { envelopeAreaMm2: 10 } }
    })
    expect(first.trace[2]).toMatchObject({
      candidate: { canonicalGeometryIdentity: 'same', metrics: { envelopeAreaMm2: 12 } },
      representative: {
        canonicalGeometryIdentity: 'same',
        metrics: { envelopeAreaMm2: 8 }
      },
      pruned: { canonicalGeometryIdentity: 'same', metrics: { envelopeAreaMm2: 12 } }
    })
    expect(first.trace[4]).toMatchObject({
      outcome: 'capacity-pruned',
      candidate: { canonicalGeometryIdentity: 'pruned' },
      representative: undefined,
      pruned: { canonicalGeometryIdentity: 'pruned' },
      retainedCanonicalGeometryIdentities: ['novel', 'same']
    })
  })

  it('keeps a topology-poor structural tradeoff when it improves compactness', () => {
    const clean = structuralHandoff('clean', {
      envelopeAreaMm2: 10,
      enclosedCavityCount: 0,
      largestOccupiedHullGapRatio: 0.05,
      totalStructuralContacts: 1
    })
    const ringyTradeoff = structuralHandoff('ringy-tradeoff', {
      envelopeAreaMm2: 8,
      enclosedCavityCount: 1,
      largestOccupiedHullGapRatio: 0.4,
      totalStructuralContacts: 3
    })

    expect(
      retainIntrinsicStructuralHandoffs([ringyTradeoff, clean], 5).map(
        ({ metrics }) => metrics.canonicalGeometryIdentity
      )
    ).toEqual(['clean', 'ringy-tradeoff'])
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
    const disruption = poolEntry(state, 'forced-disruption', 10, 'other', 10, 0)
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
        1
      ).some(({ key }) => key === 'forced-disruption')
    ).toBe(false)
  })

  it('waits for a forced checkpoint before using measured interface stagnation', async () => {
    const transforms = [transform(0, 0), transform(1, 90)]
    const pieces = [
      preparedRectangle('bottom', 6, 1, transforms),
      preparedRectangle('top', 6, 1, transforms),
      preparedRectangle('left', 1, 4, transforms),
      preparedRectangle('right', 1, 4, transforms)
    ]
    const catalog = await catalogFor(pieces)
    const ring = [
      placed(catalogEntry(catalog, 'bottom'), 0, 0, 0),
      placed(catalogEntry(catalog, 'top'), 0, 0, 5),
      placed(catalogEntry(catalog, 'left'), 0, 0, 1),
      placed(catalogEntry(catalog, 'right'), 0, 5, 1)
    ]
    const result = await runController(
      pieces,
      ring,
      schedule({
        expectedStructuralPieceCount: 4,
        sweepsPerBasin: 4,
        forcedDisruptionSweeps: [3],
        explorationAreaCapMm2: 100
      }),
      ({ provisionalPlaced }) => Effect.succeed(exactProjection(provisionalPlaced))
    )
    const firstBasin = result.trace.filter(
      ({ roleId, basinIndex }) => roleId === 'e1-envelope' && basinIndex === 0
    )

    expect(
      firstBasin.map(({ interfaceDisruptionStagnated }) => interfaceDisruptionStagnated)
    ).toEqual([false, false, true, true])
    expect(firstBasin[2]).toMatchObject({
      forcedDisruption: false,
      interfaceDisruptionProposalCount: 0
    })
    expect(firstBasin[3]?.forcedDisruption).toBe(true)
    expect(firstBasin[3]?.interfaceDisruptionProposalCount).toBeGreaterThan(0)
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
    expect(result.projectionAttemptCount).toBe(
      result.projectionLaneTrace.filter(({ outcome }) => outcome === 'selected').length
    )
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
    expect(first.projectionAttemptCount).toBe(
      first.projectionLaneTrace.filter(({ outcome }) => outcome === 'selected').length
    )
    expect(first.projectionTrace).toHaveLength(first.projectionAttemptCount)
    expect(first.projectionLaneTrace).toEqual(second.projectionLaneTrace)
    expect(
      first.projectionTrace
        .filter(({ outcome }) => outcome === 'exact-success')
        .every(({ handoffRetention }) => handoffRetention !== undefined)
    ).toBe(true)
    expect(
      first.projectionTrace.every(
        ({ lane, stateKey, rawLoss, weightedLoss }) =>
          lane.length > 0 &&
          stateKey.length > 0 &&
          Number.isFinite(rawLoss) &&
          Number.isFinite(weightedLoss)
      )
    ).toBe(true)
    expect(
      first.projectionTrace
        .filter(({ outcome }) => outcome === 'exact-success')
        .every(
          ({ structuralCanonicalGeometryIdentity }) =>
            structuralCanonicalGeometryIdentity !== undefined
        )
    ).toBe(true)
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
    expect(
      rejected.projectionTrace.every(
        ({ outcome }) => outcome === 'structural-analysis-invalid'
      )
    ).toBe(true)

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
    disruptionLineage: disruptionProtectedUntilSweep !== undefined,
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

function syntheticWallConflict(
  key: string,
  pieceId: PieceId,
  normalizedDepth: number,
  moveXGrid: number,
  moveYGrid: number
): IntrinsicSeparationEvaluation['conflicts'][number] {
  return {
    key,
    kind: 'wall',
    firstPieceId: pieceId,
    secondPieceId: undefined,
    rawDepth: normalizedDepth,
    normalizedDepth,
    moveXGrid,
    moveYGrid
  }
}

function projectionTargetRoles(): ReadonlyArray<IntrinsicGlobalTargetRole> {
  return [
    { id: 'e1-envelope', widthMm: 10, heightMm: 10, areaMm2: 100 },
    { id: 'expanded-e1-envelope', widthMm: 11, heightMm: 11, areaMm2: 121 },
    { id: 'four-three-cap', widthMm: 12, heightMm: 9, areaMm2: 108 }
  ]
}

function projectionLaneCandidate(
  targetRole: IntrinsicGlobalTargetRole | undefined,
  basinIndex: 0 | 1,
  state: IntrinsicInfeasiblePoolEntry['state'],
  key: string,
  rawLoss: number,
  weightedLoss: number,
  disruptionLineage: boolean
): IntrinsicProjectionLaneCandidate {
  if (targetRole === undefined) throw new Error('projection target role expected')
  const entry = poolEntry(state, key, rawLoss, key, rawLoss, undefined)
  return {
    targetRole,
    basinIndex,
    targetBox: { widthMm: targetRole.widthMm, heightMm: targetRole.heightMm },
    entry: {
      ...entry,
      evaluation: { ...entry.evaluation, weightedLoss },
      disruptionLineage
    },
    weights: { byConflictKey: new Map() }
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
