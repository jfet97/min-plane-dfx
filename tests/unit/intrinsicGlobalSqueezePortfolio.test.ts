import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransform,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  INTRINSIC_GLOBAL_PORTFOLIO_DEFAULTS,
  retainIntrinsicGlobalFullCandidates,
  runIntrinsicGlobalSqueezePortfolioWithDependencies,
  type IntrinsicGlobalFullCandidate,
  type IntrinsicGlobalPortfolioSchedule
} from '../../src/workers/algorithm/irregular/intrinsicGlobalSqueezePortfolio.js'
import {
  partitionIntrinsicStructuralPieces,
  type IntrinsicGlobalSearchResult,
  type IntrinsicStructuralHandoff
} from '../../src/workers/algorithm/irregular/intrinsicSqueezeDisruptSeparate.js'
import {
  constructIntrinsicStrictState,
  measureIntrinsicSheetlessCompletedLayout,
  type IntrinsicStrictConstructResult
} from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import { IrregularBeamState } from '../../src/workers/algorithm/irregular/irregularBeamState.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { IrregularNfpIfpControlAbortError } from '../../src/workers/irregular/services.js'

type MutablePortfolioSchedule = {
  -readonly [Key in keyof IntrinsicGlobalPortfolioSchedule]: IntrinsicGlobalPortfolioSchedule[Key]
}

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

function preparedRectangle(id: string, width: number, height: number): IrregularPreparedPiece {
  const points = [point(0, 0), point(width, 0), point(width, height), point(0, height)]
  const polygon = new IrregularPolygon({ points })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(id),
    source: sourcePiece(id),
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: PieceId.make(id),
      sourceBounds: new IrregularBounds({ minX: 0, minY: 0, maxX: width, maxY: height }),
      sampledPoints: points,
      convexHull: polygon,
      collisionPolygon: polygon,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms: [
      new IrregularTransformCandidate({
        index: 0,
        rotationDeg: 0,
        mirrored: false,
        reason: 'configured'
      })
    ]
  })
}

function placed(piece: IrregularPreparedPiece, x: number, y: number): IrregularPlacedPiece {
  const transform = piece.transforms[0]
  if (transform === undefined) throw new Error('transform expected')
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      pieceId: preparedPieceId(piece),
      sourcePieceId: piece.source.id,
      placementReference: piece.collisionGeometry.placementReference,
      transform: new IrregularTransform({
        translateX: x,
        translateY: y,
        rotationDeg: 0,
        mirrored: false
      })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: piece.source.id,
      transform,
      polygon: piece.collisionGeometry.collisionPolygon,
      bounds: piece.collisionGeometry.sourceBounds
    })
  })
}

function pieceAt(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  index: number
): IrregularPreparedPiece {
  const piece = pieces[index]
  if (piece === undefined) throw new Error(`piece ${index} expected`)
  return piece
}

function schedule(
  overrides: Partial<IntrinsicGlobalPortfolioSchedule> = {}
): IntrinsicGlobalPortfolioSchedule {
  return { ...INTRINSIC_GLOBAL_PORTFOLIO_DEFAULTS, maximumRuntimeMs: 20_000, ...overrides }
}

function structuralResult(input: {
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
  readonly fallback: ReadonlyArray<IrregularPlacedPiece>
  readonly handoffs?: ReadonlyArray<IntrinsicStructuralHandoff>
  readonly status?: IntrinsicGlobalSearchResult['status']
}): IntrinsicGlobalSearchResult {
  const partition = partitionIntrinsicStructuralPieces(input.pieces)
  if (partition === undefined) throw new Error('partition expected')
  return {
    status: input.status ?? 'completed',
    fullE1Fallback: input.fallback,
    partition,
    targetRoles: [],
    searchedBasinCount: 0,
    unavailableQuarterTurnBasinCount: 0,
    structuralHandoffs: input.handoffs ?? [],
    trace: [],
    projectionTrace: [],
    completedSweepCount: input.status === undefined ? 72 : 0,
    separationEvaluationCount: 10,
    projectionAttemptCount: input.handoffs?.length ?? 0,
    projectionSuccessCount: input.handoffs?.length ?? 0,
    runtimeMs: 1
  }
}

function structuralHandoff(
  projectionAttempt: number,
  frozen: ReadonlyArray<IrregularPlacedPiece>,
  metricOverrides: Partial<IntrinsicStructuralHandoff['metrics']> = {}
): IntrinsicStructuralHandoff {
  return {
    targetRoleId: 'e1-envelope',
    basinIndex: projectionAttempt % 2 === 0 ? 1 : 0,
    projectionAttempt,
    placedCollisionGeometries: frozen,
    metrics: {
      canonicalGeometryIdentity: `structural-${projectionAttempt}`,
      enclosedCavityCount: 0,
      totalEnclosedCavityAreaMm2: 0,
      largestOccupiedHullGapRatio: 0,
      envelopeAreaMm2: 1,
      envelopeMaximumSideMm: 1,
      envelopeSpanMm: 2,
      occupiedHullWasteRatio: 0,
      totalStructuralContacts: 0,
      dominantStructuralContacts: 0,
      ...metricOverrides
    }
  }
}

function constructed(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  placedEntries: ReadonlyArray<IrregularPlacedPiece>,
  unplaced: ReadonlyArray<PieceId> = [],
  nonInertFillCount = 0
): IntrinsicStrictConstructResult {
  return {
    state: new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries: placedEntries,
      unplacedPieceIds: unplaced,
      placementOrder: placedEntries.map(placedPieceId)
    }),
    stepTrace: [],
    gapFillEvidence: pieces.slice(0, nonInertFillCount).map((piece, index) => ({
      pieceId: preparedPieceId(piece),
      regionKey: `gap-${index}`,
      regionAreaBeforeMm2: 2,
      regionAreaAfterMm2: 1,
      envelopeMaximumSideDeltaMm: 0,
      envelopeAreaDeltaMm2: 0,
      sharedBoundaryLengthMm: 1,
      nonInert: true
    })),
    runtimeMs: 2
  }
}

function runPortfolio(input: {
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
  readonly fallback: ReadonlyArray<IrregularPlacedPiece>
  readonly structural: IntrinsicGlobalSearchResult
  readonly fill: Parameters<typeof runIntrinsicGlobalSqueezePortfolioWithDependencies>[2]['fill']
  readonly schedule?: IntrinsicGlobalPortfolioSchedule
  readonly control?: Parameters<typeof runIntrinsicGlobalSqueezePortfolioWithDependencies>[0]['control']
}) {
  return Effect.runPromise(
    runIntrinsicGlobalSqueezePortfolioWithDependencies(
      {
        allPreparedPieces: input.pieces,
        fullE1Placed: input.fallback,
        ...(input.control === undefined ? {} : { control: input.control })
      },
      input.schedule ?? schedule(),
      {
        runStructural: ({ control }) =>
          Effect.gen(function* () {
            if (control !== undefined) yield* control.checkpoint('candidate-points')
            return input.structural
          }),
        fill: input.fill
      }
    ).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

describe('intrinsic global squeeze portfolio', () => {
  it('returns the owned exact fallback when structural search has no handoff', async () => {
    const pieces = [preparedRectangle('a', 2, 2), preparedRectangle('b', 2, 2)]
    const fallback = [placed(pieceAt(pieces, 0), 0, 0), placed(pieceAt(pieces, 1), 2, 0)]
    const result = await runPortfolio({
      pieces,
      fallback,
      structural: structuralResult({ pieces, fallback }),
      fill: () => Effect.die('fill must not run')
    })

    expect(result.status).toBe('completed-fallback')
    expect(result.selected.source).toBe('e1-fallback')
    expect(result.completeArchive).toHaveLength(1)
    expect(result.fillTrace).toEqual([])
  })

  it('fills a topology-poor structural handoff before applying complete-layout admission', async () => {
    const pieces = [
      preparedRectangle('large-a', 4, 4),
      preparedRectangle('large-b', 4, 4),
      preparedRectangle('small', 1, 1)
    ]
    const fallback = [
      placed(pieceAt(pieces, 0), 0, 0),
      placed(pieceAt(pieces, 1), 4, 0),
      placed(pieceAt(pieces, 2), 8, 0)
    ]
    const frozen = [placed(pieceAt(pieces, 0), 0, 0), placed(pieceAt(pieces, 1), 5, 0)]
    const filled = [...frozen, placed(pieceAt(pieces, 2), 4, 0)]
    const handoff = structuralHandoff(1, frozen, {
      enclosedCavityCount: 5,
      largestOccupiedHullGapRatio: 0.9,
      envelopeAreaMm2: 999_999
    })
    const result = await runPortfolio({
      pieces,
      fallback,
      structural: structuralResult({ pieces, fallback, handoffs: [handoff] }),
      fill: () => Effect.succeed(constructed([pieceAt(pieces, 2)], filled, [], 1)),
      schedule: schedule({ maximumLargestHullGapRatio: 1 })
    })

    expect(result.structuralOutcome).toMatchObject({ structuralPieceCount: 2, fillerPieceCount: 1 })
    expect(result.status).toBe('completed-candidate')
    expect(result.selected.source).toBe('projected-gap-fill')
    expect(result.promotion).toMatchObject({
      viableCandidateCount: 1,
      productionAreaCandidateCount: 1,
      selectedAtOrBelowFallbackArea: true
    })
    expect(result.fillTrace).toEqual([
      expect.objectContaining({
        outcome: 'completed-admitted',
        insertedFillerCount: 1,
        nonInertFillCount: 1,
        unplacedFillerCount: 0
      })
    ])
    const rerun = await runPortfolio({
      pieces,
      fallback,
      structural: structuralResult({ pieces, fallback, handoffs: [handoff] }),
      fill: () => Effect.succeed(constructed([pieceAt(pieces, 2)], filled, [], 1)),
      schedule: schedule({ maximumLargestHullGapRatio: 1 })
    })
    expect(result.fillTrace).toEqual(rerun.fillTrace)
    expect(result.fillTrace[0]).not.toHaveProperty('runtimeMs')
    expect(result.fillTrace[0]).not.toHaveProperty('remainingBudgetMsAfter')
  })

  it('runs a real exact gap-contained continuation on a non-61 workload', async () => {
    const pieces = [
      preparedRectangle('horizontal', 10, 2),
      preparedRectangle('vertical', 2, 10),
      preparedRectangle('filler', 1, 1)
    ]
    const fallback = [
      placed(pieceAt(pieces, 0), 0, 0),
      placed(pieceAt(pieces, 1), 0, 2),
      placed(pieceAt(pieces, 2), 10, 0)
    ]
    const frozen = [placed(pieceAt(pieces, 0), 0, 0), placed(pieceAt(pieces, 1), 0, 2)]
    const result = await runPortfolio({
      pieces,
      fallback,
      structural: structuralResult({
        pieces,
        fallback,
        handoffs: [structuralHandoff(1, frozen)]
      }),
      fill: constructIntrinsicStrictState,
      schedule: schedule({ maximumLargestHullGapRatio: 1, explorationAreaCapMm2: 1_000 })
    })

    expect(result.fillTrace).toHaveLength(1)
    expect(result.fillTrace[0]?.insertedFillerCount).toBe(1)
    expect(result.fillTrace[0]?.unplacedFillerCount).toBe(0)
  })

  it('rejects complete area/topology failures and chooses admitted work over a bad E1', async () => {
    const pieces = [
      preparedRectangle('a', 2, 2),
      preparedRectangle('b', 2, 2),
      preparedRectangle('c', 2, 2)
    ]
    const badFallback = [
      placed(pieceAt(pieces, 0), 0, 0),
      placed(pieceAt(pieces, 1), 10, 0),
      placed(pieceAt(pieces, 2), 0, 10)
    ]
    const compact = [
      placed(pieceAt(pieces, 0), 0, 0),
      placed(pieceAt(pieces, 1), 2, 0),
      placed(pieceAt(pieces, 2), 4, 0)
    ]
    const handoff = structuralHandoff(1, compact)
    const admitted = await runPortfolio({
      pieces,
      fallback: badFallback,
      structural: structuralResult({ pieces, fallback: badFallback, handoffs: [handoff] }),
      fill: () => Effect.succeed(constructed([], compact))
    })
    expect(admitted.status).toBe('completed-candidate')
    expect(admitted.selected.source).toBe('projected-gap-fill')

    const rejected = await runPortfolio({
      pieces,
      fallback: badFallback,
      structural: structuralResult({ pieces, fallback: badFallback, handoffs: [handoff] }),
      fill: () => Effect.succeed(constructed([], compact)),
      schedule: schedule({ explorationAreaCapMm2: 1 })
    })
    expect(rejected.status).toBe('completed-fallback')
    expect(rejected.fillTrace[0]?.outcome).toBe('completed-quality-rejected')
  })

  it('deduplicates and ignores diagnostic contacts in complete candidate retention', () => {
    const first = candidateForMetrics('first', { envelopeAreaMm2: 10, totalStructuralContacts: 4 })
    const duplicate = candidateForMetrics('first', { envelopeAreaMm2: 12, totalStructuralContacts: 3 })
    const dominated = candidateForMetrics('dominated', { envelopeAreaMm2: 12, totalStructuralContacts: 3 })
    const tradeoff = candidateForMetrics('tradeoff', { envelopeAreaMm2: 9, totalStructuralContacts: 2 })

    expect(
      retainIntrinsicGlobalFullCandidates([dominated, duplicate, tradeoff, first], 5).map(
        ({ measured }) => measured.canonicalGeometryIdentity
      )
    ).toEqual(['tradeoff'])
  })

  it('ranks viable finalists by production target and then deterministic area minimization', () => {
    const missesTarget = candidateForMetrics(
      'misses-target',
      { envelopeAreaMm2: 430_345 },
      { productionAreaTargetMet: false }
    )
    const reachesTarget = candidateForMetrics(
      'reaches-target',
      { envelopeAreaMm2: 430_344 },
      { productionAreaTargetMet: true }
    )
    const smallestTarget = candidateForMetrics(
      'smallest-target',
      { envelopeAreaMm2: 420_000 },
      { productionAreaTargetMet: true }
    )

    expect(
      retainIntrinsicGlobalFullCandidates(
        [missesTarget, reachesTarget, smallestTarget],
        5
      ).map(({ measured }) => measured.canonicalGeometryIdentity)
    ).toEqual(['smallest-target'])
  })

  it('keeps admitted topology ahead of a smaller production-target layout', () => {
    const clean = candidateForMetrics(
      'clean',
      { envelopeAreaMm2: 435_000, enclosedCavityCount: 0 },
      { productionAreaTargetMet: false }
    )
    const smallerButRingier = candidateForMetrics(
      'smaller-ringier',
      { envelopeAreaMm2: 420_000, enclosedCavityCount: 1 },
      { productionAreaTargetMet: true }
    )

    expect(
      retainIntrinsicGlobalFullCandidates([smallerButRingier, clean], 5).map(
        ({ measured }) => measured.canonicalGeometryIdentity
      )
    ).toEqual(['clean', 'smaller-ringier'])
  })

  it('discards prior candidates on deadline and propagates cancellation', async () => {
    const pieces = [preparedRectangle('a', 2, 2), preparedRectangle('b', 2, 2)]
    const fallback = [placed(pieceAt(pieces, 0), 0, 0), placed(pieceAt(pieces, 1), 4, 0)]
    const compact = [placed(pieceAt(pieces, 0), 0, 0), placed(pieceAt(pieces, 1), 2, 0)]
    const handoffs = [structuralHandoff(1, compact), structuralHandoff(2, compact)]
    let fillCount = 0
    const deadline = await runPortfolio({
      pieces,
      fallback,
      structural: structuralResult({ pieces, fallback, handoffs }),
      fill: () => {
        fillCount += 1
        return fillCount === 1
          ? Effect.succeed(constructed([], compact))
          : Effect.fail(
              new IrregularNfpIfpControlAbortError({ reason: 'deadline', message: 'deadline' })
            )
      }
    })
    expect(deadline.status).toBe('deadline-fallback')
    expect(deadline.admittedCandidates).toEqual([])
    expect(deadline.selected.source).toBe('e1-fallback')
    expect(deadline.fillTrace.at(-1)?.outcome).toBe('deadline')
    expect(deadline.fillTrace.at(-1)).toMatchObject({
      insertedFillerCount: undefined,
      nonInertFillCount: undefined,
      unplacedFillerCount: undefined
    })

    await expect(
      runPortfolio({
        pieces,
        fallback,
        structural: structuralResult({ pieces, fallback }),
        fill: () => Effect.die('unused'),
        control: {
          checkpoint: () =>
            Effect.fail(
              new IrregularNfpIfpControlAbortError({ reason: 'cancelled', message: 'cancelled' })
            )
        }
      })
    ).rejects.toMatchObject({ _tag: 'IrregularNfpIfpControlAbortError', reason: 'cancelled' })
  })

  it('preserves known fill evidence when the absolute checkpoint reaches its deadline', async () => {
    const pieces = [
      preparedRectangle('large-a', 4, 4),
      preparedRectangle('large-b', 4, 4),
      preparedRectangle('small', 1, 1)
    ]
    const fallback = [
      placed(pieceAt(pieces, 0), 0, 0),
      placed(pieceAt(pieces, 1), 4, 0),
      placed(pieceAt(pieces, 2), 8, 0)
    ]
    const frozen = [placed(pieceAt(pieces, 0), 0, 0), placed(pieceAt(pieces, 1), 5, 0)]
    const filled = [...frozen, placed(pieceAt(pieces, 2), 4, 0)]
    let checkpointCount = 0
    const result = await runPortfolio({
      pieces,
      fallback,
      structural: structuralResult({
        pieces,
        fallback,
        handoffs: [structuralHandoff(1, frozen)]
      }),
      fill: () => Effect.succeed(constructed([pieceAt(pieces, 2)], filled, [], 1)),
      control: {
        checkpoint: () => {
          checkpointCount += 1
          return checkpointCount === 2
            ? Effect.fail(
                new IrregularNfpIfpControlAbortError({ reason: 'deadline', message: 'deadline' })
              )
            : Effect.void
        }
      }
    })

    expect(result.status).toBe('deadline-fallback')
    expect(result.fillTrace).toEqual([
      expect.objectContaining({
        outcome: 'deadline',
        insertedFillerCount: 1,
        nonInertFillCount: 1,
        unplacedFillerCount: 0
      })
    ])
  })

  it('owns inputs before checkpoints and emits deterministic scalar traces', async () => {
    const mutablePieces = [preparedRectangle('a', 2, 2), preparedRectangle('b', 2, 2)]
    const mutableFallback = [
      placed(pieceAt(mutablePieces, 0), 0, 0),
      placed(pieceAt(mutablePieces, 1), 2, 0)
    ]
    const structural = structuralResult({ pieces: mutablePieces, fallback: mutableFallback })
    const mutableSchedule: MutablePortfolioSchedule = { ...schedule() }
    let mutated = false
    const control = {
      checkpoint: () => {
        if (!mutated) {
          mutated = true
          mutablePieces.splice(0, mutablePieces.length)
          mutableFallback.splice(0, mutableFallback.length)
          mutableSchedule.completeArchiveCapacity = 1
          mutableSchedule.maximumRuntimeMs = 0
        }
        return Effect.void
      }
    }
    const first = await runPortfolio({
      pieces: mutablePieces,
      fallback: mutableFallback,
      structural,
      fill: () => Effect.die('unused'),
      schedule: mutableSchedule,
      control
    })
    expect(first.status).toBe('completed-fallback')
    expect(first.selected.placedCollisionGeometries).toHaveLength(2)
    expect(first.maximumRuntimeMs).toBe(20_000)

    const stablePieces = [preparedRectangle('a', 2, 2), preparedRectangle('b', 2, 2)]
    const stableFallback = [
      placed(pieceAt(stablePieces, 0), 0, 0),
      placed(pieceAt(stablePieces, 1), 2, 0)
    ]
    const run = () =>
      runPortfolio({
        pieces: stablePieces,
        fallback: stableFallback,
        structural: structuralResult({ pieces: stablePieces, fallback: stableFallback }),
        fill: () => Effect.die('unused')
      })
    const second = await run()
    const third = await run()
    expect(second.structuralOutcome).toEqual(third.structuralOutcome)
    expect(second.fillTrace).toEqual(third.fillTrace)
  })

  it('reports contact target independently from production area promotion', async () => {
    const pieces = [preparedRectangle('a', 2, 2), preparedRectangle('b', 2, 2)]
    const fallback = [placed(pieceAt(pieces, 0), 0, 0), placed(pieceAt(pieces, 1), 4, 0)]
    const compact = [placed(pieceAt(pieces, 0), 0, 0), placed(pieceAt(pieces, 1), 2, 0)]
    const result = await runPortfolio({
      pieces,
      fallback,
      structural: structuralResult({
        pieces,
        fallback,
        handoffs: [structuralHandoff(1, compact)]
      }),
      fill: () => Effect.succeed(constructed([], compact)),
      schedule: schedule({
        productionAreaTargetMm2: 1,
        historicTotalContactTarget: 0,
        historicDominantContactTarget: 0
      })
    })

    expect(result.selected.productionAreaTargetMet).toBe(false)
    expect(result.selected.historicContactTargetMet).toBe(true)
  })
})

function candidateForMetrics(
  identity: string,
  overrides: Partial<IntrinsicGlobalFullCandidate['measured']['metrics']>,
  candidateOverrides: Partial<
    Pick<
      IntrinsicGlobalFullCandidate,
      'productionAreaTargetMet' | 'historicContactTargetMet'
    >
  > = {}
): IntrinsicGlobalFullCandidate {
  const metrics = {
    envelopeMaximumSideMm: 4,
    envelopeAreaMm2: 11,
    envelopeSpanMm: 7,
    enclosedCavityCount: 0,
    totalEnclosedCavityAreaMm2: 0,
    largestOccupiedHullGapRatio: 0,
    isolatedPieceCount: 0,
    positiveContactComponentCount: 1,
    largestPositiveContactComponentSize: 1,
    largestPositiveContactComponentRatio: 1,
    occupiedAreaOutsideLargestContactComponentMm2: 0,
    occupiedHullWasteRatio: 0,
    totalStructuralContacts: 1,
    dominantStructuralContacts: 1,
    contactUnits: 1,
    sharedBoundaryLengthMm: 1,
    canonicalGeometryHash: identity,
    runtimeMs: 0,
    ...overrides
  }
  return {
    source: 'projected-gap-fill',
    structuralProjectionAttempt: 1,
    placedCollisionGeometries: [],
    measured: {
      placedCollisionGeometries: [],
      canonicalGeometryIdentity: identity,
      canonicalGeometryHash: identity,
      metrics
    },
    productionAreaTargetMet: candidateOverrides.productionAreaTargetMet ?? false,
    historicContactTargetMet: candidateOverrides.historicContactTargetMet ?? false
  }
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function placedPieceId(piece: IrregularPlacedPiece): PieceId {
  return piece.placement.pieceId ?? piece.placement.sourcePieceId
}

expect(measureIntrinsicSheetlessCompletedLayout).toBeTypeOf('function')
