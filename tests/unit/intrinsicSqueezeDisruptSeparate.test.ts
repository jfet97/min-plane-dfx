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
  advanceIntrinsicPressureAdaptiveDepth,
  advanceIntrinsicDisruptionLineage,
  classifyIntrinsicPressureCanonicalLegality,
  createIntrinsicPressureCanonicalLegalityMemo,
  describeIntrinsicPressureLossSnapshot,
  deriveIntrinsicGlobalOrdinalSeed,
  deriveIntrinsicGlobalTargetRoles,
  deriveIntrinsicContractedPressureProposal,
  diagnoseIntrinsicPressureInterruptedSweep,
  evaluateIntrinsicCanonicalControl,
  floorIntrinsicTargetGrid,
  generateIntrinsicAdaptiveTransformFamilyCandidates,
  generateIntrinsicTwoRadiusRefinementCandidates,
  inheritIntrinsicDisruptionLineage,
  INTRINSIC_GLOBAL_SEARCH_DEFAULTS,
  intrinsicPressureEndpointRejectionReason,
  isIntrinsicPressureActiveAtCap,
  measureIntrinsicPressureCompactness,
  partitionIntrinsicStructuralPieces,
  pressureRepairSweepAllowance,
  pressureRepairMaximumSweepAllowance,
  pressureProjectionPreserved,
  retainIntrinsicInfeasiblePool,
  retainIntrinsicInfeasiblePoolWithDiagnostics,
  retainIntrinsicStructuralHandoffs,
  retainIntrinsicStructuralHandoffsWithDiagnostics,
  runIntrinsicSqueezeDisruptSeparateWithSchedule,
  runIntrinsicSequentialColliderComposite,
  selectIntrinsicPressureCompositeChoice,
  selectIntrinsicProjectionWorkItems,
  type IntrinsicGlobalSearchSchedule,
  type IntrinsicGlobalTargetRole,
  type IntrinsicDisruptionLineageProvenance,
  type IntrinsicInfeasiblePoolEntry,
  type IntrinsicProjectionLaneCandidate,
  type IntrinsicStructuralHandoff
} from '../../src/workers/algorithm/irregular/intrinsicSqueezeDisruptSeparate.js'
import {
  dedupeIntrinsicRelaxedStates,
  evaluateIntrinsicSeparation,
  intrinsicDisruptionProposals,
  intrinsicFocusedProposals,
  intrinsicFocusedProposalsForPiece,
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
    expect(
      intrinsicFocusedProposalsForPiece({
        catalog,
        state,
        evaluation,
        weights: { byConflictKey: new Map() },
        selectedPieceId: PieceId.make('wide')
      })
    ).toEqual(proposals)
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

  it('publishes an observer-only structural E1 canonical control witness', async () => {
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

    expect(result.structuralE1CanonicalControl).toMatchObject({
      targetBox: { widthMm: 4, heightMm: 1 },
      structuralPieceCount: 2,
      satRawLoss: 0,
      satWeightedLoss: 0,
      satConflictCount: 0,
      satExactZeroLoss: true,
      satConflict: {
        wallConflictCount: 0,
        pairConflictCount: 0,
        conflictedPieceCount: 0
      },
      canonicalControl: {
        identityMatches: true,
        pieceCoverageMatches: true,
        candidateCanonicalLegal: true,
        accepted: true,
        reason: 'accepted'
      },
      canonicalLegality: {
        satExactZeroLoss: true,
        canonicalLegal: true,
        classification: 'sat-clear-canonical-legal'
      },
      canonicalAcceptanceIndependentOfSat: true,
      separationEvaluationBudgetCost: 0,
      selectionEligible: false
    })
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

  it('composes frozen colliders sequentially and recomputes after each commit', async () => {
    const pieces = [
      preparedRectangle('a', 2, 2),
      preparedRectangle('b', 2, 2),
      preparedRectangle('c', 2, 2),
      preparedRectangle('d', 2, 2)
    ]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 0, 0),
      placed(catalogEntry(catalog, 'c'), 0, 5, 0),
      placed(catalogEntry(catalog, 'd'), 0, 5, 0)
    ])
    if (state === undefined) throw new Error('composite state expected')
    const targetBox = { widthMm: 20, heightMm: 10 }
    const evaluation = evaluateIntrinsicSeparation(targetBox, catalog, state)
    const stateKey = intrinsicRelaxedStateKey(catalog, state)
    if (evaluation === undefined || stateKey === undefined) {
      throw new Error('composite evaluation expected')
    }
    const result = await Effect.runPromise(
      runIntrinsicSequentialColliderComposite({
        targetBox,
        catalog,
        parentState: state,
        parentEvaluation: evaluation,
        parentStateKey: stateKey,
        weights: { byConflictKey: new Map() },
        maximumEvaluations: 100,
        control: { checkpoint: () => Effect.void }
      })
    )

    expect(result.trace.frozenColliderIds).toEqual([
      PieceId.make('a'),
      PieceId.make('b'),
      PieceId.make('c'),
      PieceId.make('d')
    ])
    expect(result.trace.committedPieceCount).toBeGreaterThanOrEqual(1)
    expect(result.trace.alreadyClearPieceCount).toBeGreaterThanOrEqual(1)
    expect(result.trace.exactZeroIntermediateVisitIndex).toBeDefined()
    expect(result.trace.canonicalLegalIntermediateVisitIndex).toBeDefined()
    expect(result.trace.canonicalLegalityEvaluationCount).toBeGreaterThan(0)
    expect(result.trace.canonicalLegalityRequestCount).toBeGreaterThanOrEqual(
      result.trace.canonicalLegalityEvaluationCount
    )
    expect(result.exactZeroIntermediate).toBe(true)
    expect(result.canonicalLegalIntermediate).toBe(true)
    expect(result.evaluation.exactZeroLoss).toBe(true)
    expect(result.trace.visitedPieceIds).toEqual(
      result.trace.frozenColliderIds.slice(0, result.trace.visitedPieceCount)
    )
    expect(
      result.trace.visits
        .filter(
          ({ outcome }) => outcome === 'committed' || outcome === 'canonical-legal'
        )
        .every(
          ({
            evaluationCount,
            beforeWeightedLoss,
            afterWeightedLoss,
            candidateAccounting
          }) =>
            evaluationCount ===
              candidateAccounting.reduce(
                (count, accounting) => count + accounting.evaluatedCount,
                0
              ) +
                1 &&
            afterWeightedLoss <= beforeWeightedLoss * 1.001
        )
    ).toBe(true)
    expect(result.trace.distinctAffectedPieceCount).toBe(
      new Set(result.trace.committedPieceIds).size
    )
    expect(result.trace.orderIdentity).toBe('priority-forward')
    expect(result.trace.candidateAccounting.length).toBeGreaterThan(0)
    expect(
      result.trace.visits.flatMap(({ candidates }) => candidates).every(
        ({ source, pass, ordinal, stateKey, outcome }) =>
          source !== 'no-op' &&
          pass.length > 0 &&
          ordinal >= 0 &&
          (stateKey !== undefined || outcome === 'invalid')
      )
    ).toBe(true)
    for (const visit of result.trace.visits) {
      const firstAdaptive = visit.candidates.findIndex(
        ({ source }) => source === 'adaptive-transform-family'
      )
      if (firstAdaptive >= 0) {
        expect(
          visit.candidates
            .slice(0, firstAdaptive)
            .every(({ pass }) => pass === 'existing')
        ).toBe(true)
      }
      const uniqueKeys = visit.candidates
        .filter(({ outcome }) => outcome !== 'deduplicated')
        .flatMap(({ stateKey }) => (stateKey === undefined ? [] : [stateKey]))
      expect(new Set(uniqueKeys).size).toBe(uniqueKeys.length)
    }
  })

  it('runs priority-reverse deterministically under the same bounded composite API', async () => {
    const pieces = [
      preparedRectangle('a', 2, 2),
      preparedRectangle('b', 2, 2),
      preparedRectangle('c', 2, 2)
    ]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 0, 0),
      placed(catalogEntry(catalog, 'c'), 0, 0, 0)
    ])
    if (state === undefined) throw new Error('dual-order state expected')
    const targetBox = { widthMm: 20, heightMm: 10 }
    const evaluation = evaluateIntrinsicSeparation(targetBox, catalog, state)
    const stateKey = intrinsicRelaxedStateKey(catalog, state)
    if (evaluation === undefined || stateKey === undefined) {
      throw new Error('dual-order evaluation expected')
    }
    const reverse = await Effect.runPromise(
      runIntrinsicSequentialColliderComposite({
        targetBox,
        catalog,
        parentState: state,
        parentEvaluation: evaluation,
        parentStateKey: stateKey,
        weights: { byConflictKey: new Map() },
        maximumEvaluations: 0,
        control: { checkpoint: () => Effect.void },
        orderIdentity: 'priority-reverse'
      })
    )

    expect(reverse.trace.orderIdentity).toBe('priority-reverse')
    expect(reverse.trace.frozenColliderIds).toEqual(
      reverse.trace.frozenColliderIds.toSorted().toReversed()
    )
    expect(reverse.trace.evaluationCapReached).toBe(true)
    expect(reverse.trace.winnerSurvivedComposite).toBe(false)
    expect(reverse.trace.outerRetentionOutcome).toBe('interrupted')
  })

  it('selects deterministic transform-family representatives only for conflict axes', async () => {
    const pieces = [
      preparedRectangle('moving', 4, 1, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('fixed', 2, 2)
    ]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'moving'), 0, 0, 0),
      placed(catalogEntry(catalog, 'fixed'), 0, 3, 0)
    ])
    if (state === undefined) throw new Error('adaptive family state expected')
    const movingId = PieceId.make('moving')
    const evaluation: IntrinsicSeparationEvaluation = {
      rawLoss: 1,
      weightedLoss: 1,
      exactZeroLoss: false,
      conflicts: [syntheticWallConflict('axis-x', movingId, 1, -100, 0)]
    }
    const first = generateIntrinsicAdaptiveTransformFamilyCandidates({
      catalog,
      state,
      evaluation,
      selectedPieceId: movingId
    })
    const second = generateIntrinsicAdaptiveTransformFamilyCandidates({
      catalog,
      state,
      evaluation,
      selectedPieceId: movingId
    })

    expect(first.selectedAxes).toEqual(['x'])
    expect(first.generatedCount).toBeGreaterThan(0)
    expect(first.candidates.every(({ pass }) => pass === 'adaptive-axis-x')).toBe(true)
    expect(first.candidates.map(({ stateKey }) => stateKey)).toEqual(
      second.candidates.map(({ stateKey }) => stateKey)
    )
  })

  it('keeps the two-radius 16-position refinement behind an explicit API call', async () => {
    const pieces = [
      preparedRectangle('anchor', 1, 1),
      preparedRectangle('moving', 4, 2)
    ]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'anchor'), 0, 0, 0),
      placed(catalogEntry(catalog, 'moving'), 0, 8, 8)
    ])
    if (state === undefined) throw new Error('refinement state expected')
    const refinement = generateIntrinsicTwoRadiusRefinementCandidates({
      targetBox: { widthMm: 30, heightMm: 30 },
      catalog,
      seedState: state,
      selectedPieceId: PieceId.make('moving')
    })

    expect(refinement).toMatchObject({
      invoked: true,
      generatedCount: 16,
      targetLegalCount: 16,
      uniqueCount: 16
    })
    expect(refinement?.smallRadiusGrid).toBeLessThan(
      refinement?.largeRadiusGrid ?? 0
    )
  })

  it('judges canonical controls by identity, coverage, and canonical legality', async () => {
    const pieces = [preparedRectangle('a', 2, 2), preparedRectangle('b', 2, 2)]
    const catalog = await catalogFor(pieces)
    const reference = [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 2, 0)
    ]
    const translated = reference
      .toReversed()
      .map((entry) => translatePlaced(entry, 5, 6))
    const illegal = [reference[0], placed(catalogEntry(catalog, 'b'), 0, 1.999, 0)].filter(
      (entry): entry is IrregularPlacedPiece => entry !== undefined
    )

    expect(
      evaluateIntrinsicCanonicalControl({
        targetBox: { widthMm: 20, heightMm: 20 },
        referencePlaced: reference,
        candidatePlaced: translated
      })
    ).toMatchObject({ accepted: true, reason: 'accepted' })
    expect(
      evaluateIntrinsicCanonicalControl({
        targetBox: { widthMm: 20, heightMm: 20 },
        referencePlaced: illegal,
        candidatePlaced: illegal
      })
    ).toMatchObject({
      identityMatches: true,
      candidateCanonicalLegal: false,
      accepted: false,
      reason: 'candidate-canonical-illegal'
    })
  })

  it('ranks composite choices deterministically and falls back to no-op', () => {
    expect(
      selectIntrinsicPressureCompositeChoice(1, [
        { stateKey: 'b', weightedLoss: 0.9, rawLoss: 0.5 },
        { stateKey: 'a', weightedLoss: 0.9, rawLoss: 0.5 },
        { stateKey: 'c', weightedLoss: 0.9, rawLoss: 0.6 }
      ])
    ).toBe('a')
    expect(
      selectIntrinsicPressureCompositeChoice(1, [
        { stateKey: 'within-tolerance', weightedLoss: 1.001, rawLoss: 0.5 }
      ])
    ).toBe('within-tolerance')
    expect(
      selectIntrinsicPressureCompositeChoice(1, [
        { stateKey: 'too-expensive', weightedLoss: 1.001_001, rawLoss: 0.1 }
      ])
    ).toBeUndefined()
  })

  it('uses canonical target legality as endpoint authority and caches the cross-check', async () => {
    const pieces = [preparedRectangle('a', 2, 2), preparedRectangle('b', 2, 2)]
    const catalog = await catalogFor(pieces)
    const legalState = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 2, 0)
    ])
    const overlappingState = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 1.999, 0)
    ])
    if (legalState === undefined || overlappingState === undefined) {
      throw new Error('canonical classification states expected')
    }
    const targetBox = { widthMm: 10, heightMm: 10 }
    const falseRejectEvaluation: IntrinsicSeparationEvaluation = {
      rawLoss: Number.MIN_VALUE,
      weightedLoss: Number.MIN_VALUE,
      exactZeroLoss: false,
      conflicts: [
        syntheticWallConflict('floating-residue', PieceId.make('a'), Number.MIN_VALUE, 0, 0)
      ]
    }
    const falseAcceptEvaluation: IntrinsicSeparationEvaluation = {
      rawLoss: 0,
      weightedLoss: 0,
      exactZeroLoss: true,
      conflicts: []
    }
    const memo = createIntrinsicPressureCanonicalLegalityMemo()
    const falseReject = classifyIntrinsicPressureCanonicalLegality({
      targetBox,
      catalog,
      state: legalState,
      evaluation: falseRejectEvaluation,
      memo
    })
    const cachedFalseReject = classifyIntrinsicPressureCanonicalLegality({
      targetBox,
      catalog,
      state: legalState,
      evaluation: falseRejectEvaluation,
      memo
    })
    const falseAccept = classifyIntrinsicPressureCanonicalLegality({
      targetBox,
      catalog,
      state: overlappingState,
      evaluation: falseAcceptEvaluation,
      memo
    })

    expect(falseReject).toMatchObject({
      classification: 'sat-conflict-canonical-legal',
      canonicalLegal: true,
      satExactZeroLoss: false
    })
    expect(cachedFalseReject).toEqual(falseReject)
    expect(falseAccept).toMatchObject({
      classification: 'sat-clear-canonical-illegal',
      canonicalLegal: false,
      satExactZeroLoss: true
    })
    expect(memo).toMatchObject({
      requestCount: 3,
      evaluationCount: 2,
      cacheHitCount: 1,
      disagreementCount: 2
    })
  })

  it('preserves projection identity across reordering and rigid reanchoring', async () => {
    const pieces = [
      preparedRectangle('a', 3, 2),
      preparedRectangle('b', 2, 1),
      preparedRectangle('c', 1, 4)
    ]
    const catalog = await catalogFor(pieces)
    const original = [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 3, 0),
      placed(catalogEntry(catalog, 'c'), 0, 5, 0)
    ]
    const reanchored = original
      .toReversed()
      .map((entry) => translatePlaced(entry, 123.456, 987.654))
    const before = measureIntrinsicPressureCompactness(original)?.compactness
    const after = measureIntrinsicPressureCompactness(reanchored)?.compactness

    expect(after?.canonicalIdentity).toBe(before?.canonicalIdentity)
    expect(after?.areaWeightedCentroidDispersion).toBe(
      before?.areaWeightedCentroidDispersion
    )
    expect(pressureProjectionPreserved(before, after)).toBe(true)
    expect(
      pressureProjectionPreserved(before, {
        ...(after ?? {
          canonicalIdentity: '',
          envelopeAreaMm2: 0,
          envelopeMaximumSideMm: 0,
          areaWeightedCentroidDispersion: 0,
          enclosedCavityCount: 0,
          largestOccupiedHullGapRatio: 0
        }),
        areaWeightedCentroidDispersion:
          (after?.areaWeightedCentroidDispersion ?? 0) + Number.EPSILON
      })
    ).toBe(true)
    expect(
      pressureProjectionPreserved(before, {
        ...(after ?? {
          canonicalIdentity: '',
          envelopeAreaMm2: 0,
          envelopeMaximumSideMm: 0,
          areaWeightedCentroidDispersion: 0,
          enclosedCavityCount: 0,
          largestOccupiedHullGapRatio: 0
        }),
        canonicalIdentity: `${after?.canonicalIdentity ?? ''}:different`
      })
    ).toBe(false)
  })

  it('records composite evaluation-cap and deadline interruptions truthfully', async () => {
    const pieces = [preparedRectangle('a', 2, 2), preparedRectangle('b', 2, 2)]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 0, 0)
    ])
    if (state === undefined) throw new Error('interrupted composite state expected')
    const targetBox = { widthMm: 10, heightMm: 10 }
    const evaluation = evaluateIntrinsicSeparation(targetBox, catalog, state)
    const stateKey = intrinsicRelaxedStateKey(catalog, state)
    if (evaluation === undefined || stateKey === undefined) {
      throw new Error('interrupted composite evaluation expected')
    }
    const base = {
      targetBox,
      catalog,
      parentState: state,
      parentEvaluation: evaluation,
      parentStateKey: stateKey,
      weights: { byConflictKey: new Map() }
    }
    const capped = await Effect.runPromise(
      runIntrinsicSequentialColliderComposite({
        ...base,
        maximumEvaluations: 0,
        control: { checkpoint: () => Effect.void }
      })
    )
    const deadline = await Effect.runPromise(
      runIntrinsicSequentialColliderComposite({
        ...base,
        maximumEvaluations: 100,
        control: {
          checkpoint: () =>
            Effect.fail(
              new IrregularNfpIfpControlAbortError({
                reason: 'deadline',
                message: 'composite deadline fixture'
              })
            )
        }
      })
    )

    expect(capped.trace).toMatchObject({
      evaluationCapReached: true,
      deadlineReached: false,
      emittedComposite: false,
      outerRetentionOutcome: 'interrupted'
    })
    expect(capped.trace.visits[0]?.outcome).toBe('evaluation-cap')
    expect(capped.trace.compositeStateKey).toBe(stateKey)
    expect(deadline.trace).toMatchObject({
      evaluationCapReached: false,
      deadlineReached: true,
      visitedPieceCount: 0,
      emittedComposite: false,
      outerRetentionOutcome: 'interrupted'
    })
    expect(deadline.trace.compositeStateKey).toBe(stateKey)
  })

  it('records a composite no-op with the unchanged end-state key', async () => {
    const pieces = [preparedRectangle('a', 2, 2)]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0)
    ])
    const stateKey =
      state === undefined ? undefined : intrinsicRelaxedStateKey(catalog, state)
    if (state === undefined || stateKey === undefined) {
      throw new Error('no-op composite state expected')
    }
    const pieceId = PieceId.make('a')
    const syntheticEvaluation: IntrinsicSeparationEvaluation = {
      rawLoss: 1,
      weightedLoss: 1,
      exactZeroLoss: false,
      conflicts: [syntheticWallConflict('synthetic', pieceId, 1, 0, 0)]
    }
    const result = await Effect.runPromise(
      runIntrinsicSequentialColliderComposite({
        targetBox: { widthMm: 10, heightMm: 10 },
        catalog,
        parentState: state,
        parentEvaluation: syntheticEvaluation,
        parentStateKey: stateKey,
        weights: { byConflictKey: new Map() },
        maximumEvaluations: 10,
        control: { checkpoint: () => Effect.void }
      })
    )

    expect(result.trace).toMatchObject({
      compositeStateKey: stateKey,
      emittedComposite: false,
      skippedPieceIds: [pieceId],
      outerRetentionOutcome: 'not-emitted'
    })
    expect(result.trace.visits[0]?.outcome).toBe('no-op')
  })

  it('diagnoses an interrupted sweep from its whole candidate set', async () => {
    const pieces = [preparedRectangle('a', 2, 2)]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0)
    ])
    if (state === undefined) throw new Error('interrupted diagnostic state expected')
    const weights = { byConflictKey: new Map<string, number>() }
    const start = poolEntry(state, 'start', 1, 'start-conflict', 1, undefined)
    const generated = poolEntry(
      state,
      'generated',
      0.25,
      'generated-conflict',
      0.25,
      undefined
    )
    const startSnapshot = describeIntrinsicPressureLossSnapshot(start, weights)
    const diagnostics = diagnoseIntrinsicPressureInterruptedSweep({
      pool: [start],
      candidates: [start, generated],
      generatedCandidates: [generated],
      weights,
      startPreGls: startSnapshot,
      bestRawLossBeforeSweep: 1,
      bestRepairedLoss: 0.25,
      repairSweep: 2,
      firstBestSweepIndex: undefined,
      compositeParents: []
    })

    expect(diagnostics.generatedBestPreGls?.stateKey).toBe('generated')
    expect(diagnostics.preGlsImprovementDeltaRawLoss).toBe(0.75)
    expect(diagnostics.preGlsImprovementDeltaWeightedLoss).toBe(0.75)
    expect(diagnostics.firstBestSweepIndex).toBe(2)
    expect(diagnostics.rawWinnerStateKey).toBe('generated')
    expect(diagnostics.rawWinnerRetained).toBe(false)
    expect(diagnostics.retainedRawWinnerStateKey).toBe('start')
    expect(diagnostics.retainedWeightedWinnerStateKey).toBe('start')
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

  it('contracts the longer side from an area-weighted polygon-centroid median split', async () => {
    const pieces = [
      preparedRectangle('large', 4, 2),
      preparedRectangle('small-b', 1, 2),
      preparedRectangle('small-c', 1, 2)
    ]
    const catalog = await catalogFor(pieces)
    const exact = [
      placed(catalogEntry(catalog, 'large'), 0, 0, 0),
      placed(catalogEntry(catalog, 'small-b'), 0, 10, 0),
      placed(catalogEntry(catalog, 'small-c'), 0, 20, 0)
    ]
    const proposal = deriveIntrinsicContractedPressureProposal(catalog, exact, 0.1)
    if (proposal === undefined) throw new Error('contracted pressure proposal expected')
    const translated = provisionalLayoutFromRelaxedState(catalog, proposal.state)
    if (translated === undefined) throw new Error('translated pressure layout expected')
    const before = measureIntrinsicPressureCompactness(exact)
    const after = measureIntrinsicPressureCompactness(translated)

    expect(proposal).toMatchObject({
      contractionAxis: 'x',
      removedWidthMm: 2.1,
      areaWeightedMedianGrid: 2_000,
      nearPartitionPieceIds: [PieceId.make('large')],
      farPartitionPieceIds: [PieceId.make('small-b'), PieceId.make('small-c')]
    })
    expect(
      translated.find(({ placement }) => placement.pieceId === PieceId.make('small-b'))
        ?.placement.transform.translateX
    ).toBe(7.9)
    expect(after?.compactness.areaWeightedCentroidDispersion).toBeLessThan(
      before?.compactness.areaWeightedCentroidDispersion ?? 0
    )
  })

  it('enforces every exact pressure acceptance guard independently', () => {
    const parent = {
      canonicalIdentity: 'parent',
      envelopeAreaMm2: 100,
      envelopeMaximumSideMm: 20,
      areaWeightedCentroidDispersion: 0.5,
      enclosedCavityCount: 1,
      largestOccupiedHullGapRatio: 0.2
    }
    const accepted = {
      canonicalIdentity: 'accepted',
      envelopeAreaMm2: 90,
      envelopeMaximumSideMm: 19,
      areaWeightedCentroidDispersion: 0.4,
      enclosedCavityCount: 1,
      largestOccupiedHullGapRatio: 0.2
    }

    expect(intrinsicPressureEndpointRejectionReason(parent, accepted)).toBeUndefined()
    expect(
      intrinsicPressureEndpointRejectionReason(parent, {
        ...accepted,
        canonicalIdentity: parent.canonicalIdentity
      })
    ).toContain('identical')
    expect(
      intrinsicPressureEndpointRejectionReason(parent, {
        ...accepted,
        envelopeMaximumSideMm: parent.envelopeMaximumSideMm
      })
    ).toContain('maximum side')
    expect(
      intrinsicPressureEndpointRejectionReason(parent, {
        ...accepted,
        envelopeAreaMm2: parent.envelopeAreaMm2
      })
    ).toContain('envelope area')
    expect(
      intrinsicPressureEndpointRejectionReason(parent, {
        ...accepted,
        areaWeightedCentroidDispersion: parent.areaWeightedCentroidDispersion
      })
    ).toContain('dispersion')
    expect(
      intrinsicPressureEndpointRejectionReason(parent, {
        ...accepted,
        enclosedCavityCount: parent.enclosedCavityCount + 1
      })
    ).toContain('cavities')
    expect(
      intrinsicPressureEndpointRejectionReason(parent, {
        ...accepted,
        largestOccupiedHullGapRatio: parent.largestOccupiedHullGapRatio + 0.01
      })
    ).toContain('hull-gap')
  })

  it('splits the registered repair budget evenly without adding sweeps', () => {
    expect([0, 1, 2].map((index) => pressureRepairSweepAllowance(12, index))).toEqual([
      4, 4, 4
    ])
    expect([0, 1, 2].map((index) => pressureRepairSweepAllowance(5, index))).toEqual([
      2, 2, 1
    ])
    expect(pressureRepairSweepAllowance(12, 3)).toBe(0)
  })

  it('extends only the registered four-sweep pressure attempts to eight', () => {
    expect(
      [0, 1, 2].map((index) => pressureRepairMaximumSweepAllowance(12, index))
    ).toEqual([8, 8, 8])
    expect(
      [0, 1, 2].map((index) => pressureRepairMaximumSweepAllowance(5, index))
    ).toEqual([2, 2, 1])
    for (const totalSweepBudget of [10, 11, 13]) {
      expect(
        [0, 1, 2].map((index) =>
          pressureRepairMaximumSweepAllowance(totalSweepBudget, index)
        )
      ).toEqual(
        [0, 1, 2].map((index) =>
          pressureRepairSweepAllowance(totalSweepBudget, index)
        )
      )
    }
    expect(pressureRepairMaximumSweepAllowance(12, 3)).toBe(0)
  })

  it('keeps four sweeps mandatory before applying adaptive raw-loss stopping', () => {
    let consecutiveExtraNonImprovementCount = 0
    for (let completedSweepCount = 1; completedSweepCount <= 4; completedSweepCount += 1) {
      const decision = advanceIntrinsicPressureAdaptiveDepth({
        completedSweepCount,
        mandatorySweepCount: 4,
        priorBestRawLoss: 1,
        completedBestRawLoss: 1,
        consecutiveExtraNonImprovementCount
      })
      consecutiveExtraNonImprovementCount =
        decision.consecutiveExtraNonImprovementCount
      expect(decision).toEqual({
        consecutiveExtraNonImprovementCount: 0,
        shouldStop: false
      })
    }
  })

  it('continues improving extra sweeps and resets the non-improvement streak', () => {
    const firstFlat = advanceIntrinsicPressureAdaptiveDepth({
      completedSweepCount: 5,
      mandatorySweepCount: 4,
      priorBestRawLoss: 1,
      completedBestRawLoss: 1,
      consecutiveExtraNonImprovementCount: 0
    })
    const improved = advanceIntrinsicPressureAdaptiveDepth({
      completedSweepCount: 6,
      mandatorySweepCount: 4,
      priorBestRawLoss: 1,
      completedBestRawLoss: 0.9,
      consecutiveExtraNonImprovementCount:
        firstFlat.consecutiveExtraNonImprovementCount
    })
    const secondFlat = advanceIntrinsicPressureAdaptiveDepth({
      completedSweepCount: 7,
      mandatorySweepCount: 4,
      priorBestRawLoss: 0.9,
      completedBestRawLoss: 0.9,
      consecutiveExtraNonImprovementCount:
        improved.consecutiveExtraNonImprovementCount
    })

    expect(firstFlat).toEqual({
      consecutiveExtraNonImprovementCount: 1,
      shouldStop: false
    })
    expect(improved).toEqual({
      consecutiveExtraNonImprovementCount: 0,
      shouldStop: false
    })
    expect(secondFlat).toEqual({
      consecutiveExtraNonImprovementCount: 1,
      shouldStop: false
    })
  })

  it('stops after two consecutive non-improving extra sweeps', () => {
    const first = advanceIntrinsicPressureAdaptiveDepth({
      completedSweepCount: 5,
      mandatorySweepCount: 4,
      priorBestRawLoss: 1,
      completedBestRawLoss: 1,
      consecutiveExtraNonImprovementCount: 0
    })
    const second = advanceIntrinsicPressureAdaptiveDepth({
      completedSweepCount: 6,
      mandatorySweepCount: 4,
      priorBestRawLoss: 1,
      completedBestRawLoss: 1,
      consecutiveExtraNonImprovementCount:
        first.consecutiveExtraNonImprovementCount
    })

    expect(second).toEqual({
      consecutiveExtraNonImprovementCount: 2,
      shouldStop: true
    })
  })

  it('classifies only a positive improving eighth sweep as active at cap', () => {
    expect(
      isIntrinsicPressureActiveAtCap({
        adaptiveEnabled: true,
        completedSweepCount: 8,
        maximumSweepCount: 8,
        priorBestRawLoss: 0.2,
        completedBestRawLoss: 0.1
      })
    ).toBe(true)
    expect(
      isIntrinsicPressureActiveAtCap({
        adaptiveEnabled: true,
        completedSweepCount: 8,
        maximumSweepCount: 8,
        priorBestRawLoss: 0.1,
        completedBestRawLoss: 0.1
      })
    ).toBe(false)
    expect(
      isIntrinsicPressureActiveAtCap({
        adaptiveEnabled: true,
        completedSweepCount: 8,
        maximumSweepCount: 8,
        priorBestRawLoss: 0.1,
        completedBestRawLoss: 0
      })
    ).toBe(false)
    expect(
      isIntrinsicPressureActiveAtCap({
        adaptiveEnabled: false,
        completedSweepCount: 2,
        maximumSweepCount: 2,
        priorBestRawLoss: 0.2,
        completedBestRawLoss: 0.1
      })
    ).toBe(false)
  })

  it('records pressure diagnostics without changing retention or evaluation counts', async () => {
    const pieces = [preparedRectangle('near', 4, 2), preparedRectangle('far', 4, 2)]
    const catalog = await catalogFor(pieces)
    const touching = [
      placed(catalogEntry(catalog, 'near'), 0, 0, 0),
      placed(catalogEntry(catalog, 'far'), 0, 4, 0)
    ]
    const controllerSchedule = schedule({
      sweepsPerBasin: 5,
      maximumSeparationEvaluations: 200,
      explorationAreaCapMm2: 20
    })
    const project = ({
      provisionalPlaced
    }: {
      readonly provisionalPlaced: ReadonlyArray<IrregularPlacedPiece>
    }) => Effect.succeed(exactProjection(provisionalPlaced))
    const first = await runController(pieces, touching, controllerSchedule, project)
    const second = await runController(pieces, touching, controllerSchedule, project)
    const sweeps = first.contractedPressureTrace.flatMap(({ repairSweeps }) => repairSweeps)

    expect(sweeps.length).toBeGreaterThan(0)
    expect(
      first.contractedPressureTrace.every(
        ({ repairSweeps }, attemptIndex) =>
          repairSweeps.length <= pressureRepairSweepAllowance(5, attemptIndex) &&
          repairSweeps.every(
            ({ terminationReason }) => terminationReason !== 'active-at-cap'
          )
      )
    ).toBe(true)
    expect(first.separationEvaluationCount).toBe(second.separationEvaluationCount)
    expect(first.pressureRepairSweepCount).toBe(second.pressureRepairSweepCount)
    expect(first.contractedPressureTrace).toEqual(second.contractedPressureTrace)
    expect(
      first.structuralHandoffs.map(({ metrics }) => metrics.canonicalGeometryIdentity)
    ).toEqual(
      second.structuralHandoffs.map(({ metrics }) => metrics.canonicalGeometryIdentity)
    )
    expect(
      sweeps.every(
        ({
          startPreGls,
          retainedRawBestPreGls,
          retainedRawBestPostGls,
          retainedWeightedBestPostGls,
          retainedRawWinnerStateKey,
          retainedWeightedWinnerStateKey
        }) =>
          startPreGls !== undefined &&
          retainedRawBestPreGls !== undefined &&
          retainedRawBestPostGls !== undefined &&
          retainedWeightedBestPostGls !== undefined &&
          retainedRawWinnerStateKey !== undefined &&
          retainedWeightedWinnerStateKey !== undefined
      )
    ).toBe(true)
    expect(
      sweeps.some(
        ({ generatedBestPreGls, glsDriverStateKey, weightUpdates }) =>
          generatedBestPreGls !== undefined &&
          generatedBestPreGls.conflictedPieceCount > 0 &&
          glsDriverStateKey !== undefined &&
          weightUpdates.length > 0
      )
    ).toBe(true)
    for (const sweep of sweeps) {
      expect(sweep.evaluatedProposalCount).toBe(
        sweep.compositeParents.reduce(
          (count, parent) => count + parent.evaluationCount,
          0
        )
      )
      expect(sweep.emittedProposalCount).toBe(
        sweep.compositeParents.reduce(
          (count, parent) =>
            count +
            parent.visits.reduce(
              (visitCount, visit) =>
                visitCount + Math.max(0, visit.proposalCount - 1),
              0
            ),
          0
        )
      )
      expect(sweep.evaluatedProposalCount).toBeGreaterThanOrEqual(
        sweep.generatedUniqueCandidateCount
      )
      expect(sweep.wholeCandidateSetUniqueCount).toBeGreaterThanOrEqual(
        sweep.generatedUniqueCandidateCount
      )
      if (sweep.startPreGls !== undefined && sweep.generatedBestPreGls !== undefined) {
        expect(sweep.preGlsImprovementDeltaRawLoss).toBe(
          sweep.startPreGls.rawLoss - sweep.generatedBestPreGls.rawLoss
        )
        expect(sweep.preGlsImprovementDeltaWeightedLoss).toBe(
          sweep.startPreGls.weightedLoss - sweep.generatedBestPreGls.weightedLoss
        )
      }
      if (
        sweep.retainedRawBestPreGls !== undefined &&
        sweep.retainedRawBestPostGls !== undefined
      ) {
        expect(sweep.retainedRawBestPostGls.rawLoss).toBe(
          sweep.retainedRawBestPreGls.rawLoss
        )
        expect(sweep.retainedRawWinnerStateKey).toBe(
          sweep.retainedRawBestPostGls.stateKey
        )
      }
    }

    const state = relaxedStateFromExactLayout(catalog, touching)
    if (state === undefined) throw new Error('pressure diagnostic state expected')
    const diagnosticEntry: IntrinsicInfeasiblePoolEntry = {
      ...poolEntry(state, 'diagnostic', 0.25, 'wall:near:left', 0.25, undefined),
      searchScope: 'contracted-pressure',
      pressureGeneration: {
        parentStateKey: 'parent',
        childStateKey: 'diagnostic',
        generationDepth: 2,
        selectedPieceIds: [PieceId.make('near')],
        affectedPieceIds: [PieceId.make('near')],
        lineageAffectedPieceIds: [PieceId.make('far'), PieceId.make('near')],
        proposalKind: 'separate'
      }
    }
    const weights = { byConflictKey: new Map([['wall:near:left', 3]]) }
    const retainedBefore = retainIntrinsicInfeasiblePool(
      [diagnosticEntry],
      1,
      weights,
      0
    )
    const snapshot = describeIntrinsicPressureLossSnapshot(diagnosticEntry, weights)
    const retainedAfter = retainIntrinsicInfeasiblePool(
      [diagnosticEntry],
      1,
      weights,
      0
    )

    expect(retainedAfter).toEqual(retainedBefore)
    expect(snapshot?.weightedLoss).toBe(0.75)
    expect(
      describeIntrinsicPressureLossSnapshot(diagnosticEntry, {
        byConflictKey: new Map([['wall:near:left', 5]])
      })?.weightedLoss
    ).toBe(1.25)
    expect(snapshot).toMatchObject({
      stateKey: 'diagnostic',
      parentStateKey: 'parent',
      childStateKey: 'diagnostic',
      generationDepth: 2,
      affectedPieceCount: 1,
      lineageAffectedPieceCount: 2,
      conflictedPieceCount: 1,
      wallConflictCount: 1,
      pairConflictCount: 0,
      topConflicts: [
        {
          key: 'wall:near:left',
          wallSide: 'left',
          weightedContribution: 0.75
        }
      ]
    })
  })

  it('runs four deterministic composite passes without changing outer order', async () => {
    const pieces = [preparedRectangle('near', 4, 2), preparedRectangle('far', 4, 2)]
    const catalog = await catalogFor(pieces)
    const touching = [
      placed(catalogEntry(catalog, 'near'), 0, 0, 0),
      placed(catalogEntry(catalog, 'far'), 0, 4, 0)
    ]
    const controllerSchedule = schedule({
      sweepsPerBasin: 12,
      maximumSeparationEvaluations: 2_000,
      explorationAreaCapMm2: 20
    })
    const project = ({
      provisionalPlaced
    }: {
      readonly provisionalPlaced: ReadonlyArray<IrregularPlacedPiece>
    }) => Effect.succeed(exactProjection(provisionalPlaced))
    const first = await runController(pieces, touching, controllerSchedule, project)
    const second = await runController(pieces, touching, controllerSchedule, project)
    const attempts = first.contractedPressureTrace.map(({ repairSweeps }) => repairSweeps)
    const completedSweeps = attempts.flat()

    expect(first.separationEvaluationCount).toBe(second.separationEvaluationCount)
    expect(first.pressureRepairSweepCount).toBe(second.pressureRepairSweepCount)
    expect(first.contractedPressureTrace).toEqual(second.contractedPressureTrace)
    expect(
      first.structuralHandoffs.map(({ metrics }) => metrics.canonicalGeometryIdentity)
    ).toEqual(
      second.structuralHandoffs.map(({ metrics }) => metrics.canonicalGeometryIdentity)
    )
    expect(attempts.every((repairSweeps) => repairSweeps.length <= 4)).toBe(true)
    expect(attempts.some((repairSweeps) => repairSweeps.length === 4)).toBe(true)
    expect(
      completedSweeps
        .filter(({ sweepIndex }) => sweepIndex < 4)
        .every(
          ({ terminationReason, consecutiveExtraNonImprovementCount }) =>
            terminationReason !== 'adaptive-non-improvement' &&
            terminationReason !== 'active-at-cap' &&
            consecutiveExtraNonImprovementCount === 0
        )
    ).toBe(true)
    expect(
      completedSweeps.every(({ compositeParents }) =>
        compositeParents.every(
          ({
            frozenColliderIds,
            visitedPieceIds,
            exactZeroIntermediateVisitIndex,
            evaluationCapReached,
            deadlineReached
          }) =>
            exactZeroIntermediateVisitIndex !== undefined ||
            evaluationCapReached ||
            deadlineReached ||
            frozenColliderIds.length === visitedPieceIds.length
        )
      )
    ).toBe(true)
  })

  it('marks earlier emitted composites interrupted when a later parent hits the deadline', async () => {
    const pieces = [
      preparedRectangle('a', 2, 2),
      preparedRectangle('b', 2, 2),
      preparedRectangle('c', 2, 2),
      preparedRectangle('d', 2, 2)
    ]
    const catalog = await catalogFor(pieces)
    const touching = [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 2, 0),
      placed(catalogEntry(catalog, 'c'), 0, 4, 0),
      placed(catalogEntry(catalog, 'd'), 0, 6, 0)
    ]
    let checkpointCount = 0
    const result = await runController(
      pieces,
      touching,
      schedule({
        expectedStructuralPieceCount: 4,
        sweepsPerBasin: 12,
        maximumSeparationEvaluations: 2_000,
        explorationAreaCapMm2: 20
      }),
      ({ provisionalPlaced }) => Effect.succeed(exactProjection(provisionalPlaced)),
      {
        checkpoint: () => {
          checkpointCount += 1
          return checkpointCount === 30
            ? Effect.fail(
                new IrregularNfpIfpControlAbortError({
                  reason: 'deadline',
                  message: 'composite parent deadline fixture'
                })
              )
            : Effect.void
        }
      }
    )
    const interrupted = result.contractedPressureTrace
      .flatMap(({ repairSweeps }) => repairSweeps)
      .find(({ terminationReason }) => terminationReason === 'deadline-during-composite')
    if (interrupted === undefined) throw new Error('interrupted sweep trace expected')
    const emittedParent = interrupted.compositeParents.find(
      ({ emittedComposite }) => emittedComposite
    )
    const deadlineParent = interrupted.compositeParents.find(
      ({ deadlineReached }) => deadlineReached
    )

    expect(interrupted.compositeParents.length).toBeGreaterThanOrEqual(2)
    expect(emittedParent?.outerRetentionOutcome).toBe('interrupted')
    expect(deadlineParent?.outerRetentionOutcome).toBe('interrupted')
    expect(
      interrupted.compositeParents.every(
        ({ compositeStateKey }) => compositeStateKey.length > 0
      )
    ).toBe(true)
    expect(interrupted.generatedBestPreGls).toBeDefined()
    expect(interrupted.startPreGls).toBeDefined()
    expect(interrupted.preGlsImprovementDeltaRawLoss).toBe(
      (interrupted.startPreGls?.rawLoss ?? 0) -
        (interrupted.generatedBestPreGls?.rawLoss ?? 0)
    )
    expect(interrupted.preGlsImprovementDeltaWeightedLoss).toBe(
      (interrupted.startPreGls?.weightedLoss ?? 0) -
        (interrupted.generatedBestPreGls?.weightedLoss ?? 0)
    )
    expect(interrupted.retainedRawWinnerStateKey).toBe(
      interrupted.retainedRawBestPreGls?.stateKey
    )
    expect(interrupted.retainedWeightedWinnerStateKey).toBe(
      interrupted.retainedWeightedBestPostGls?.stateKey
    )
  })

  it('reserves one accepted exact pressure endpoint without raising the projection cap', async () => {
    const pieces = [preparedRectangle('near', 4, 2), preparedRectangle('far', 4, 2)]
    const catalog = await catalogFor(pieces)
    const e1 = [
      placed(catalogEntry(catalog, 'near'), 0, 0, 0),
      placed(catalogEntry(catalog, 'far'), 0, 6, 0)
    ]
    const result = await runController(
      pieces,
      e1,
      schedule({ sweepsPerBasin: 2, explorationAreaCapMm2: 30 }),
      ({ provisionalPlaced }) => Effect.succeed(exactProjection(provisionalPlaced))
    )
    const accepted = result.contractedPressureTrace.filter(
      ({ outcome }) => outcome === 'accepted'
    )
    const projected = result.projectionLaneTrace.find(
      ({ lane }) => lane === 'contracted-pressure'
    )
    const retainedTrace = [...result.contractedPressureTrace]
      .reverse()
      .find(({ preProjectionCompactness }) => preProjectionCompactness !== undefined)

    expect(accepted.length).toBeGreaterThan(0)
    expect(result.contractedPressureTrace).toHaveLength(3)
    expect(result.contractedPressureTrace.map(({ ratioScheduleIndex }) => ratioScheduleIndex)).toEqual([
      0, 0, 0
    ])
    expect(projected).toMatchObject({ outcome: 'selected' })
    expect(result.projectionAttemptCount).toBeLessThanOrEqual(5)
    expect(retainedTrace?.preProjectionCompactness).toEqual(
      retainedTrace?.postProjectionCompactness
    )
    expect(retainedTrace?.retainedPressureIdentity).toBe(
      retainedTrace?.preProjectionCompactness?.canonicalIdentity
    )
    expect(result.completedSweepCount).toBe(6)
    expect(result.trace).toHaveLength(6)
    expect(new Set(result.trace.map(({ roleId }) => roleId))).toEqual(
      new Set(['e1-envelope', 'expanded-e1-envelope', 'four-three-cap'])
    )
    expect(
      result.trace.every(
        ({ retainedSearchScopes }) =>
          retainedSearchScopes.length === 1 &&
          retainedSearchScopes[0] === 'ordinary-e5.1'
      )
    ).toBe(true)
    expect(result.pressureRepairSweepCount).toBeLessThanOrEqual(2)
  })

  it('projects an accepted pressure endpoint before ordinary budget fallback', async () => {
    const transforms = [transform(0, 0), transform(1, 90)]
    const pieces = [
      preparedRectangle('near', 4, 2, transforms),
      preparedRectangle('far', 4, 2, transforms)
    ]
    const catalog = await catalogFor(pieces)
    const e1 = [
      placed(catalogEntry(catalog, 'near'), 0, 0, 0),
      placed(catalogEntry(catalog, 'far'), 0, 6, 0)
    ]
    const result = await runController(
      pieces,
      e1,
      schedule({
        sweepsPerBasin: 0,
        maximumSeparationEvaluations: 6,
        explorationAreaCapMm2: 30
      }),
      ({ provisionalPlaced }) => Effect.succeed(exactProjection(provisionalPlaced))
    )
    const projectedAttempt = result.contractedPressureTrace.find(
      ({ postProjectionCompactness }) => postProjectionCompactness !== undefined
    )

    expect(result.status).toBe('budget-fallback')
    expect(result.projectionAttemptCount).toBe(1)
    expect(result.projectionAttemptCount).toBeLessThanOrEqual(5)
    expect(projectedAttempt?.preProjectionCompactness).toEqual(
      projectedAttempt?.postProjectionCompactness
    )
    expect(result.structuralHandoffs).toHaveLength(1)
  })

  it('projects an accepted pressure endpoint before ordinary deadline fallback', async () => {
    const pieces = [preparedRectangle('near', 4, 2), preparedRectangle('far', 4, 2)]
    const catalog = await catalogFor(pieces)
    const e1 = [
      placed(catalogEntry(catalog, 'near'), 0, 0, 0),
      placed(catalogEntry(catalog, 'far'), 0, 6, 0)
    ]
    let checkpointCount = 0
    const result = await runController(
      pieces,
      e1,
      schedule({ sweepsPerBasin: 1, explorationAreaCapMm2: 30 }),
      ({ provisionalPlaced }) => Effect.succeed(exactProjection(provisionalPlaced)),
      {
        checkpoint: () => {
          checkpointCount += 1
          return checkpointCount === 4
            ? Effect.fail(
                new IrregularNfpIfpControlAbortError({
                  reason: 'deadline',
                  message: 'ordinary search deadline'
                })
              )
            : Effect.void
        }
      }
    )
    const projectedAttempt = result.contractedPressureTrace.find(
      ({ postProjectionCompactness }) => postProjectionCompactness !== undefined
    )

    expect(result.status).toBe('deadline-fallback')
    expect(result.projectionAttemptCount).toBe(1)
    expect(result.projectionAttemptCount).toBeLessThanOrEqual(5)
    expect(projectedAttempt?.preProjectionCompactness).toEqual(
      projectedAttempt?.postProjectionCompactness
    )
    expect(result.structuralHandoffs).toHaveLength(1)
  })

  it('runs all three pressure attempts before ordinary search and decays after failure', async () => {
    const transforms = [transform(0, 0), transform(1, 90)]
    const pieces = [
      preparedRectangle('near', 4, 2, transforms),
      preparedRectangle('far', 4, 2, transforms)
    ]
    const catalog = await catalogFor(pieces)
    const touching = [
      placed(catalogEntry(catalog, 'near'), 0, 0, 0),
      placed(catalogEntry(catalog, 'far'), 0, 4, 0)
    ]
    const result = await runController(
      pieces,
      touching,
      schedule({
        sweepsPerBasin: 0,
        maximumSeparationEvaluations: 6,
        explorationAreaCapMm2: 20
      }),
      ({ provisionalPlaced }) => Effect.succeed(exactProjection(provisionalPlaced))
    )

    expect(result.contractedPressureTrace).toHaveLength(3)
    expect(result.contractedPressureTrace.map(({ ratioScheduleIndex }) => ratioScheduleIndex)).toEqual([
      0, 1, 2
    ])
    expect(result.contractedPressureTrace[0]?.separationEvaluationCount).toBe(1)
    expect(result.separationEvaluationCount).toBeLessThanOrEqual(6)
    expect(result.status).toBe('budget-fallback')
  })

  it('does not count a repair sweep when the deadline fires before repair work', async () => {
    const pieces = [preparedRectangle('near', 4, 2), preparedRectangle('far', 4, 2)]
    const catalog = await catalogFor(pieces)
    const touching = [
      placed(catalogEntry(catalog, 'near'), 0, 0, 0),
      placed(catalogEntry(catalog, 'far'), 0, 4, 0)
    ]
    let checkpointCount = 0
    const result = await runController(
      pieces,
      touching,
      schedule({ sweepsPerBasin: 3, explorationAreaCapMm2: 20 }),
      ({ provisionalPlaced }) => Effect.succeed(exactProjection(provisionalPlaced)),
      {
        checkpoint: () => {
          checkpointCount += 1
          return checkpointCount === 2
            ? Effect.fail(
                new IrregularNfpIfpControlAbortError({
                  reason: 'deadline',
                  message: 'deadline before pressure repair work'
                })
              )
            : Effect.void
        }
      }
    )

    expect(result.status).toBe('deadline-fallback')
    expect(result.pressureRepairSweepCount).toBe(0)
    expect(result.contractedPressureTrace[0]?.reason).toContain('deadline')
    expect(result.contractedPressureTrace[0]?.repairSweeps).toEqual([
      expect.objectContaining({
        terminationReason: 'deadline-before-work',
        startPreGls: undefined,
        generatedBestPreGls: undefined,
        retainedRawBestPreGls: undefined,
        retainedRawBestPostGls: undefined,
        retainedWeightedBestPostGls: undefined,
        wholeCandidateSetUniqueCount: undefined,
        emittedProposalCount: 0,
        evaluatedProposalCount: 0
      })
    ])
  })

  it('rejects a projector mismatch while preserving truthful pre/post pressure tuples', async () => {
    const pieces = [preparedRectangle('near', 4, 2), preparedRectangle('far', 4, 2)]
    const catalog = await catalogFor(pieces)
    const e1 = [
      placed(catalogEntry(catalog, 'near'), 0, 0, 0),
      placed(catalogEntry(catalog, 'far'), 0, 6, 0)
    ]
    let projectionCall = 0
    const result = await runController(
      pieces,
      e1,
      schedule({ sweepsPerBasin: 1, explorationAreaCapMm2: 30 }),
      ({ provisionalPlaced }) => {
        projectionCall += 1
        if (projectionCall !== 1) {
          return Effect.succeed(exactProjection(provisionalPlaced))
        }
        const changed = provisionalPlaced.map((entry) =>
          entry.placement.pieceId === PieceId.make('near')
            ? movePlaced(
                entry,
                entry.placement.transform.translateX + 0.1,
                entry.placement.transform.translateY
              )
            : entry
        )
        return Effect.succeed(exactProjection(changed))
      }
    )
    const retainedTrace = [...result.contractedPressureTrace]
      .reverse()
      .find(({ preProjectionCompactness }) => preProjectionCompactness !== undefined)
    const pressureProjection = result.projectionTrace.find(
      ({ lane }) => lane === 'contracted-pressure'
    )

    expect(pressureProjection?.outcome).toBe('projection-identity-mismatch')
    expect(retainedTrace?.preProjectionCompactness).toBeDefined()
    expect(retainedTrace?.postProjectionCompactness).toBeDefined()
    expect(retainedTrace?.postProjectionCompactness).not.toEqual(
      retainedTrace?.preProjectionCompactness
    )
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
      disruptionLineage: true,
      disruptionLineageProvenance: {
        originSweep: 4,
        originProposalKind: 'split-squeeze' as const,
        originStateKey: 'disrupted-origin',
        depth: 2
      }
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
    expect(retained[0]?.disruptionLineageProvenance).toEqual(
      disrupted.disruptionLineageProvenance
    )
  })

  it('keeps deterministic disruption provenance and depth across descendants and dedupe', async () => {
    const pieces = [preparedRectangle('a', 1, 1), preparedRectangle('b', 1, 1)]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 2, 0)
    ])
    if (state === undefined) throw new Error('state expected')
    const ordinary = poolEntry(state, 'same-state', 1, 'ordinary', 1, undefined)
    const laterOrigin = advanceIntrinsicDisruptionLineage(
      ordinary,
      'split-squeeze',
      4,
      'later-origin'
    )
    if (laterOrigin === undefined) throw new Error('lineage origin expected')
    const descendant = advanceIntrinsicDisruptionLineage(
      {
        disruptionLineage: true,
        disruptionLineageProvenance: laterOrigin
      },
      'separate',
      5,
      'descendant'
    )
    expect(descendant).toEqual({ ...laterOrigin, depth: 1 })
    const earlierOrigin = advanceIntrinsicDisruptionLineage(
      ordinary,
      'group-transport',
      2,
      'earlier-origin'
    )
    if (earlierOrigin === undefined || descendant === undefined) {
      throw new Error('deterministic provenance expected')
    }
    const candidates = [
      {
        ...poolEntry(state, 'same-state', 1, 'later', 1, undefined),
        disruptionLineage: true,
        disruptionLineageProvenance: descendant
      },
      {
        ...poolEntry(state, 'same-state', 2, 'earlier', 2, undefined),
        disruptionLineage: true,
        disruptionLineageProvenance: earlierOrigin
      }
    ]
    const forward = retainIntrinsicInfeasiblePool(
      candidates,
      1,
      { byConflictKey: new Map() },
      6
    )
    const reversed = retainIntrinsicInfeasiblePool(
      [...candidates].reverse(),
      1,
      { byConflictKey: new Map() },
      6
    )

    expect(forward).toEqual(reversed)
    expect(forward[0]?.evaluation.rawLoss).toBe(1)
    expect(forward[0]?.disruptionLineageProvenance).toEqual(earlierOrigin)
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
      projectionLaneCandidate(roles[0], 0, state, 'raw', 1, 0.1, false),
      projectionLaneCandidate(roles[0], 0, state, 'gls', 2, 0.2, true),
      projectionLaneCandidate(roles[0], 1, state, 'e1-disruption', 3, 0.3, true),
      projectionLaneCandidate(roles[1], 1, state, 'expanded-disruption', 4, 0.4, true),
      projectionLaneCandidate(roles[2], 0, state, 'four-three-disruption', 5, 0.5, true)
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
    expect(first.trace[1]).toMatchObject({
      lane: 'global-final-gls',
      eligibleCandidateCount: 5,
      skippedDuplicateCount: 1,
      stateKey: 'gls'
    })
    expect(first.trace[2]).toMatchObject({
      lane: 'role-disruption',
      requestedTargetRoleId: 'e1-envelope',
      eligibleCandidateCount: 2,
      skippedDuplicateCount: 1,
      stateKey: 'e1-disruption'
    })
  })

  it('gives a duplicate accepted pressure endpoint ownership of the shared projection slot', async () => {
    const pieces = [preparedRectangle('a', 1, 1), preparedRectangle('b', 1, 1)]
    const catalog = await catalogFor(pieces)
    const state = relaxedStateFromExactLayout(catalog, [
      placed(catalogEntry(catalog, 'a'), 0, 0, 0),
      placed(catalogEntry(catalog, 'b'), 0, 2, 0)
    ])
    if (state === undefined) throw new Error('state expected')
    const roles = projectionTargetRoles()
    const raw = projectionLaneCandidate(roles[0], 0, state, 'same', 0, 0, false)
    const selection = selectIntrinsicProjectionWorkItems([raw], roles, raw)

    expect(selection.workItems).toHaveLength(1)
    expect(selection.workItems[0]?.lane).toBe('contracted-pressure')
    expect(selection.trace[0]).toMatchObject({
      lane: 'contracted-pressure',
      outcome: 'selected'
    })
    expect(selection.trace[1]).toMatchObject({
      lane: 'global-raw',
      outcome: 'lane-collapsed',
      collapsedIntoWorkIdentity: selection.workItems[0]?.workIdentity
    })
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
      collapsedIntoWorkIdentity: selection.workItems[1]?.workIdentity,
      eligibleCandidateCount: 1,
      skippedDuplicateCount: 1
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

  it('protects forced disruption, GLS, and post-birth active lineage inside width eight', async () => {
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
    ).toBe(true)

    const crowdedCandidates = [
      hot,
      ...Array.from({ length: 8 }, (_, index) =>
        poolEntry(
          state,
          `ordinary-${index}`,
          1.1 + index / 10,
          `ordinary-${index}`,
          1.1 + index / 10,
          undefined
        )
      ),
      {
        ...poolEntry(state, 'active-lineage', 100, 'lineage', 100, undefined),
        disruptionLineage: true,
        disruptionLineageProvenance: {
          originSweep: 0,
          originProposalKind: 'swap' as const,
          originStateKey: 'active-lineage',
          depth: 1
        }
      }
    ]
    const postBirthRetention = retainIntrinsicInfeasiblePoolWithDiagnostics(
      crowdedCandidates,
      8,
      { byConflictKey: new Map() },
      1
    )

    expect(postBirthRetention.pool).toHaveLength(8)
    expect(postBirthRetention.pool.some(({ key }) => key === 'active-lineage')).toBe(true)
    expect(postBirthRetention).toMatchObject({
      retainedLineageCount: 1,
      activeLineageRetentionOutcome: 'reserved-active-lineage',
      reservedLineage: {
        stateKey: 'active-lineage',
        originSweep: 0,
        originProposalKind: 'swap',
        depth: 1
      }
    })
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
    expect(firstBasin[3]?.directDisruptionProposalCounts.interfaceDisrupt).toBeGreaterThan(0)
    expect(firstBasin[3]?.preDeduplicationLineageCount).toBeGreaterThan(0)
    expect(firstBasin[3]?.postDeduplicationLineageCount).toBeGreaterThan(0)
    expect(firstBasin[3]?.retainedLineageCount).toBeGreaterThan(0)
    expect(firstBasin[3]?.reservedLineage).toBeDefined()
    expect(firstBasin[3]?.shadowLineageSnapshot).toBeDefined()
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

function translatePlaced(
  entry: IrregularPlacedPiece,
  deltaX: number,
  deltaY: number
): IrregularPlacedPiece {
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: entry.placement.sourcePieceId,
      ...(entry.placement.pieceId === undefined
        ? {}
        : { pieceId: entry.placement.pieceId }),
      ...(entry.placement.placementReference === undefined
        ? {}
        : { placementReference: entry.placement.placementReference }),
      transform: new IrregularTransform({
        ...entry.placement.transform,
        translateX: entry.placement.transform.translateX + deltaX,
        translateY: entry.placement.transform.translateY + deltaY
      })
    }),
    collisionGeometry: entry.collisionGeometry
  })
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
  const disruptionLineageProvenance: IntrinsicDisruptionLineageProvenance | undefined =
    disruptionProtectedUntilSweep === undefined
      ? undefined
      : {
          originSweep: disruptionProtectedUntilSweep,
          originProposalKind: 'swap',
          originStateKey: key,
          depth: 0
        }
  return {
    searchScope: 'ordinary-e5.1',
    state,
    key,
    disruptionLineage: disruptionLineageProvenance !== undefined,
    disruptionLineageProvenance,
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
      disruptionLineage,
      disruptionLineageProvenance: disruptionLineage
        ? {
            originSweep: 0,
            originProposalKind: 'swap',
            originStateKey: key,
            depth: 0
          }
        : undefined
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
