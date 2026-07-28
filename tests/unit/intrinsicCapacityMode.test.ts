import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
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
  compareIntrinsicCapacityEndpoints,
  intrinsicCapacityEndpointPartitionsRequest,
  materializeIntrinsicCapacityEndpoint,
  type IntrinsicCapacityCavityCache
} from '../../src/workers/algorithm/irregular/intrinsicCapacityEndpoint.js'
import {
  intrinsicCapacityMaterialAreas,
  intrinsicCapacityPreparedPieceId
} from '../../src/workers/algorithm/irregular/intrinsicCapacityMaterial.js'
import {
  runIntrinsicCapacityMode,
  type IntrinsicCapacityModeResult,
  type RunIntrinsicCapacityModeInput
} from '../../src/workers/algorithm/irregular/intrinsicCapacityMode.js'
import {
  preflightIntrinsicCompleteCapacity,
  type IntrinsicCapacityPreflightOutcome
} from '../../src/workers/algorithm/irregular/intrinsicCapacityPreflight.js'
import {
  captureIntrinsicCapacityPrefixDescriptors,
  intrinsicCapacityPrefixDepths,
  terminalizeIntrinsicCapacityPrefixEndpoints
} from '../../src/workers/algorithm/irregular/intrinsicCapacityPrefixes.js'
import {
  compareIntrinsicCapacityEnvelopeAreas,
  runIntrinsicCapacityColdSearch
} from '../../src/workers/algorithm/irregular/intrinsicCapacitySearch.js'
import {
  observeIntrinsicPlaceDeferCompleteShadow,
  runIntrinsicPlaceDeferCompleteShadow
} from '../../src/workers/algorithm/irregular/intrinsicPlaceDeferCompleteShadow.js'
import { constructIntrinsicStrictState } from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import {
  runIntrinsicSharedArchiveDirectPortfolio,
  runIntrinsicSharedArchivePortfolio
} from '../../src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.js'
import { IrregularBeamState } from '../../src/workers/algorithm/irregular/irregularBeamState.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { makePlacedCollisionSpatialIndex } from '../../src/workers/irregular/placedCollisionSpatialIndex.js'
import {
  IrregularNfpIfpControlAbortError,
  type NfpIfpService
} from '../../src/workers/irregular/services.js'

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
  const shape = new IrregularPolygon({ points })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(id),
    source: sourcePiece(id),
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: PieceId.make(id),
      sourceBounds: bounds(points),
      sampledPoints: points,
      convexHull: shape,
      collisionPolygon: shape,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms
  })
}

function preparedRectangleWithMaterialHull(
  id: string,
  collisionWidth: number,
  collisionHeight: number,
  materialWidth: number,
  materialHeight: number
): IrregularPreparedPiece {
  const prepared = preparedRectangle(id, collisionWidth, collisionHeight)
  const materialPoints = rectanglePoints(materialWidth, materialHeight)
  return new IrregularPreparedPiece({
    ...prepared,
    collisionGeometry: new CollisionGeometry({
      ...prepared.collisionGeometry,
      convexHull: new IrregularPolygon({ points: materialPoints })
    })
  })
}

function sheet(width: number, height: number): SheetSpec {
  return new SheetSpec({ width, height, label: `${width}x${height}` })
}

function provideGeometry<A, E>(
  effect: Effect.Effect<A, E, GeometryKernel | GeometrySettings | NfpIfpService>
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

function preflight(
  finalSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>
): Promise<IntrinsicCapacityPreflightOutcome> {
  return provideGeometry(preflightIntrinsicCompleteCapacity(finalSheet, pieces))
}

function inconclusiveOutcome(
  finalSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>
): IntrinsicCapacityPreflightOutcome {
  return {
    kind: 'inconclusive',
    measurements: {
      pieceCount: pieces.length,
      sheetWidthGrid: finalSheet.width * 1000,
      sheetHeightGrid: finalSheet.height * 1000,
      sheetDoubledAreaGrid2: 0n,
      minimumDoubledCollisionAreaSumGrid2: 0n,
      minimumCollisionAreaPressurePpm: 0n,
      maximumSingletonSpanPressurePpm: 0n,
      singletonInfeasiblePieceIds: []
    }
  }
}

function runMode(
  input: Omit<RunIntrinsicCapacityModeInput, 'preflight' | 'routing'> &
    Partial<Pick<RunIntrinsicCapacityModeInput, 'preflight' | 'routing'>>
): Promise<IntrinsicCapacityModeResult> {
  return provideGeometry(
    runIntrinsicCapacityMode({
      routing: 'preflight-proven-impossible',
      preflight: inconclusiveOutcome(input.sheet, input.preparedPieces),
      ...input
    })
  )
}

function materialsOf(pieces: ReadonlyArray<IrregularPreparedPiece>): ReadonlyMap<PieceId, bigint> {
  const materials = intrinsicCapacityMaterialAreas(pieces)
  if (materials.kind !== 'complete') throw new Error('test pieces must have exact material areas')
  return materials.areasByPieceId
}

function placedRectangle(
  piece: IrregularPreparedPiece,
  translateX: number,
  translateY: number
): IrregularPlacedPiece {
  const geometry = piece.collisionGeometry
  const pieceTransform = piece.transforms[0]
  if (pieceTransform === undefined) throw new Error('test piece must have one transform')
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      sourcePieceId: piece.source.id,
      ...(piece.pieceId === undefined ? {} : { pieceId: piece.pieceId }),
      transform: new IrregularTransform({
        translateX,
        translateY,
        rotationDeg: pieceTransform.rotationDeg,
        mirrored: pieceTransform.mirrored
      })
    }),
    collisionGeometry: new TransformedCollisionGeometry({
      sourcePieceId: piece.source.id,
      transform: pieceTransform,
      polygon: geometry.collisionPolygon,
      bounds: bounds(geometry.collisionPolygon.points)
    })
  })
}

describe('intrinsic capacity preflight', () => {
  it('proves impossibility from the exact collision area sum', async () => {
    const pieces = [
      preparedRectangle('square-a', 60, 60),
      preparedRectangle('square-b', 60, 60),
      preparedRectangle('square-c', 60, 60)
    ]
    const outcome = await preflight(sheet(100, 100), pieces)
    expect(outcome.kind).toBe('proven_impossible')
    if (outcome.kind !== 'proven_impossible') return
    expect(outcome.reason).toBe('minimum-collision-area-exceeds-sheet-area')
    expect(outcome.measurements.minimumDoubledCollisionAreaSumGrid2).toBe(
      3n * 2n * 60_000n * 60_000n
    )
    expect(outcome.measurements.sheetDoubledAreaGrid2).toBe(2n * 100_000n * 100_000n)
    expect(outcome.measurements.minimumCollisionAreaPressurePpm).toBe(1_080_000n)
    expect(outcome.measurements.maximumSingletonSpanPressurePpm).toBe(600_000n)
  })

  it('proves impossibility from an exact singleton q0/q90 fit failure', async () => {
    const pieces = [
      preparedRectangle('fits', 90, 20),
      preparedRectangle('never-fits', 150, 20, [transform(0, 0), transform(1, 90)])
    ]
    const outcome = await preflight(sheet(100, 100), pieces)
    expect(outcome.kind).toBe('proven_impossible')
    if (outcome.kind !== 'proven_impossible') return
    expect(outcome.reason).toBe('singleton-transform-set-does-not-fit')
    if (outcome.reason !== 'singleton-transform-set-does-not-fit') return
    expect(outcome.pieceId).toBe('never-fits')
  })

  it('stays inconclusive for physically impossible but unproven requests', async () => {
    const pieces = [preparedRectangle('square-a', 60, 60), preparedRectangle('square-b', 60, 60)]
    const outcome = await preflight(sheet(100, 100), pieces)
    expect(outcome.kind).toBe('inconclusive')
    expect(outcome.measurements.singletonInfeasiblePieceIds).toEqual([])
  })

  it('honors cancellation while measuring transformed proof geometry', async () => {
    const pieces = [preparedRectangle('square-a', 60, 60)]
    const failure = await provideGeometry(
      preflightIntrinsicCompleteCapacity(sheet(100, 100), pieces, {
        checkpoint: () =>
          Effect.fail(
            new IrregularNfpIfpControlAbortError({
              reason: 'cancelled',
              message: 'test preflight cancellation'
            })
          )
      }).pipe(Effect.flip)
    )
    expect(failure._tag).toBe('IrregularNfpIfpControlAbortError')
    if (failure._tag !== 'IrregularNfpIfpControlAbortError') return
    expect(failure.reason).toBe('cancelled')
  })

  it('honors deadline censoring while measuring transformed proof geometry', async () => {
    const pieces = [preparedRectangle('square-a', 60, 60)]
    let checkpoints = 0
    const failure = await provideGeometry(
      preflightIntrinsicCompleteCapacity(sheet(100, 100), pieces, {
        checkpoint: () => {
          checkpoints += 1
          return checkpoints > 1
            ? Effect.fail(
                new IrregularNfpIfpControlAbortError({
                  reason: 'deadline',
                  message: 'test preflight deadline'
                })
              )
            : Effect.void
        }
      }).pipe(Effect.flip)
    )
    expect(failure._tag).toBe('IrregularNfpIfpControlAbortError')
    if (failure._tag !== 'IrregularNfpIfpControlAbortError') return
    expect(failure.reason).toBe('deadline')
  })
})

describe('intrinsic capacity search', () => {
  it('orders one-grid-square envelope differences exactly near the coordinate limit', () => {
    expect(
      compareIntrinsicCapacityEnvelopeAreas(
        { widthGrid: 999_999_999, heightGrid: 999_999_999 },
        { widthGrid: 999_999_998, heightGrid: 1_000_000_000 }
      )
    ).toBeGreaterThan(0)
  })

  it('returns the exact best subset with a complete partition when only one piece fits', async () => {
    const pieces = [
      preparedRectangle('square-a', 60, 60),
      preparedRectangle('square-b', 60, 60),
      preparedRectangle('square-c', 60, 60)
    ]
    const result = await runMode({
      sheet: sheet(100, 100),
      preparedPieces: pieces,
      prefixSources: []
    })
    expect(result.endpoint.metrics.placedCount).toBe(1)
    expect(result.endpoint.unplacedPreparedIds).toHaveLength(2)
    expect(
      intrinsicCapacityEndpointPartitionsRequest(
        result.endpoint,
        pieces.map(intrinsicCapacityPreparedPieceId)
      )
    ).toBe(true)
    expect(result.trace.coldSearch.settlement).toBe('exhausted')
    expect(result.trace.coldSearch.auxiliaryPlacementEvaluations).toBe(0)
    expect(result.endpoint.metrics.placedDoubledMaterialAreaGrid2).toBe(2n * 60_000n * 60_000n)
  })

  it('prefers several smaller pieces over one larger piece through skip successors', async () => {
    const pieces = [
      preparedRectangle('large', 90, 90),
      preparedRectangle('small-a', 50, 45),
      preparedRectangle('small-b', 50, 45)
    ]
    const result = await runMode({
      sheet: sheet(100, 100),
      preparedPieces: pieces,
      prefixSources: []
    })
    expect(result.endpoint.metrics.placedCount).toBe(2)
    expect([...result.endpoint.placedPreparedIds].toSorted()).toEqual(['small-a', 'small-b'])
    expect(result.endpoint.unplacedPreparedIds).toEqual(['large'])
  })

  it('prefers more unpadded material when placed counts tie', async () => {
    const pieces = [preparedRectangle('large', 80, 80), preparedRectangle('smaller', 79, 79)]
    const result = await runMode({
      sheet: sheet(100, 100),
      preparedPieces: pieces,
      prefixSources: []
    })
    expect(result.endpoint.metrics.placedCount).toBe(1)
    expect(result.endpoint.placedPreparedIds).toEqual(['large'])
    expect(result.endpoint.unplacedPreparedIds).toEqual(['smaller'])
  })

  it('does not deduplicate equal collision geometry with different material accounting', async () => {
    const pieces = [
      preparedRectangleWithMaterialHull('low-material', 60, 60, 40, 40),
      preparedRectangleWithMaterialHull('high-material', 60, 60, 60, 60)
    ]
    const result = await runMode({
      sheet: sheet(60, 60),
      preparedPieces: pieces,
      prefixSources: []
    })
    expect(result.endpoint.metrics.placedCount).toBe(1)
    expect(result.endpoint.placedPreparedIds).toEqual(['high-material'])
    expect(result.endpoint.unplacedPreparedIds).toEqual(['low-material'])
  })

  it('keeps equal attainable count and material searchable and beats a spread incumbent', async () => {
    const pieces = [preparedRectangle('square-a', 50, 50), preparedRectangle('square-b', 50, 50)]
    const spreadState = new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries: [
        placedRectangle(pieces[0] as IrregularPreparedPiece, 0, 0),
        placedRectangle(pieces[1] as IrregularPreparedPiece, 150, 0)
      ],
      placementOrder: pieces.map(intrinsicCapacityPreparedPieceId)
    })
    const cavityCache: IntrinsicCapacityCavityCache = new Map()
    const materials = materialsOf(pieces)
    const incumbent = materializeIntrinsicCapacityEndpoint({
      sheet: sheet(220, 220),
      state: spreadState,
      unplacedPreparedIds: [],
      origin: 'prefix-incumbent',
      sourceRole: 'canonical-grid',
      prefixDepth: 2,
      materialAreasByPieceId: materials,
      cavityCache
    })
    expect(incumbent).toBeDefined()
    if (incumbent === undefined) return

    const cold = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: sheet(220, 220),
        preparedPieces: pieces,
        materialAreasByPieceId: materials,
        cavityCache,
        incumbent
      })
    )
    const best = cold.endpoints[0]
    expect(best).toBeDefined()
    if (best === undefined) return
    expect(best.metrics.placedCount).toBe(2)
    expect(best.metrics.placedDoubledMaterialAreaGrid2).toBe(
      incumbent.metrics.placedDoubledMaterialAreaGrid2
    )
    expect(best.metrics.envelopeAreaMm2).toBeLessThan(incumbent.metrics.envelopeAreaMm2)
    expect(compareIntrinsicCapacityEndpoints(best, incumbent)).toBeLessThan(0)
  })

  it('selects the rigid q90 orientation when only q90 fits the requested sheet', async () => {
    const pieces = [
      preparedRectangle('wide', 100, 50),
      preparedRectangle('wide-b', 100, 50)
    ]
    const result = await runMode({
      sheet: sheet(60, 120),
      preparedPieces: pieces,
      prefixSources: []
    })
    expect(result.endpoint.metrics.placedCount).toBe(1)
    expect(result.endpoint.selectedRotationDeg).toBe(90)
    expect(result.endpoint.unplacedPreparedIds).toHaveLength(1)
  })

  it('fails on cancellation instead of settling a capacity result', async () => {
    const pieces = [preparedRectangle('square-a', 60, 60), preparedRectangle('square-b', 60, 60)]
    let checkpoints = 0
    const failure = await provideGeometry(
      runIntrinsicCapacityMode({
        sheet: sheet(100, 100),
        preparedPieces: pieces,
        routing: 'preflight-proven-impossible',
        preflight: inconclusiveOutcome(sheet(100, 100), pieces),
        prefixSources: [],
        control: {
          checkpoint: () => {
            checkpoints += 1
            return checkpoints > 2
              ? Effect.fail(
                  new IrregularNfpIfpControlAbortError({
                    reason: 'cancelled',
                    message: 'test cancellation'
                  })
                )
              : Effect.void
          }
        }
      }).pipe(Effect.flip)
    )
    expect(failure._tag).toBe('IrregularNfpIfpControlAbortError')
    if (failure._tag !== 'IrregularNfpIfpControlAbortError') return
    expect(failure.reason).toBe('cancelled')
  })

  it('fails on deadline censoring instead of settling a capacity result', async () => {
    const pieces = [preparedRectangle('square-a', 60, 60), preparedRectangle('square-b', 60, 60)]
    const failure = await provideGeometry(
      runIntrinsicCapacityMode({
        sheet: sheet(100, 100),
        preparedPieces: pieces,
        routing: 'preflight-proven-impossible',
        preflight: inconclusiveOutcome(sheet(100, 100), pieces),
        prefixSources: [],
        control: {
          checkpoint: () =>
            Effect.fail(
              new IrregularNfpIfpControlAbortError({
                reason: 'deadline',
                message: 'test deadline'
              })
            )
        }
      }).pipe(Effect.flip)
    )
    expect(failure._tag).toBe('IrregularNfpIfpControlAbortError')
    if (failure._tag !== 'IrregularNfpIfpControlAbortError') return
    expect(failure.reason).toBe('deadline')
  })

  it('replays deterministically with identical descriptors, pruning, endpoint, and trace', async () => {
    const pieces = [
      preparedRectangle('square-a', 60, 60),
      preparedRectangle('square-b', 60, 60),
      preparedRectangle('square-c', 40, 40)
    ]
    const first = await runMode({
      sheet: sheet(110, 62),
      preparedPieces: pieces,
      prefixSources: []
    })
    const second = await runMode({
      sheet: sheet(110, 62),
      preparedPieces: pieces,
      prefixSources: []
    })
    const stripRuntime = ({
      runtimeMs: _runtimeMs,
      coldSearchMs: _coldSearchMs,
      prefixTerminalizationMs: _prefixTerminalizationMs,
      preflightRuntimeMs: _preflightRuntimeMs,
      completeArchiveRuntimeMs: _completeArchiveRuntimeMs,
      ...trace
    }: IntrinsicCapacityModeResult['trace']) => trace
    expect(stripRuntime(first.trace)).toEqual(stripRuntime(second.trace))
    expect(first.endpoint.canonicalGeometryHash).toBe(second.endpoint.canonicalGeometryHash)
    expect(first.endpoint.placedPreparedIds).toEqual(second.endpoint.placedPreparedIds)
    expect(first.endpoint.unplacedPreparedIds).toEqual(second.endpoint.unplacedPreparedIds)
  })

  it('resumes at depth boundaries with the uninterrupted trace and endpoint', async () => {
    const pieces = [
      preparedRectangle('large', 90, 90),
      preparedRectangle('small-a', 50, 45),
      preparedRectangle('small-b', 50, 45),
      preparedRectangle('small-c', 45, 40)
    ]
    const finalSheet = sheet(100, 100)
    const materialAreasByPieceId = materialsOf(pieces)
    const uninterrupted = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map()
      })
    )
    const paused = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        maximumDepthBoundaries: 1
      })
    )

    expect(paused.status).toBe('paused')
    expect(paused.endpoints).toEqual([])
    expect(paused.trace.settlement).toBe('paused')
    expect(paused.checkpoint?.nextDepth).toBe(1)
    expect(paused.checkpoint?.frontier.length).toBeGreaterThan(0)
    expect(paused.checkpoint?.budgetLedgers.perDepth).toHaveLength(1)
    expect(paused.checkpoint?.frontier.every(({ cursor }) => cursor === 1)).toBe(true)

    const firstCheckpoint = paused.checkpoint
    expect(firstCheckpoint).toBeDefined()
    if (firstCheckpoint === undefined) return
    const pausedAgain = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        checkpoint: firstCheckpoint,
        maximumDepthBoundaries: 1
      })
    )
    expect(pausedAgain.status).toBe('paused')
    expect(pausedAgain.checkpoint?.nextDepth).toBe(2)
    expect(pausedAgain.checkpoint?.budgetLedgers.perDepth).toHaveLength(2)
    const secondCheckpoint = pausedAgain.checkpoint
    expect(secondCheckpoint).toBeDefined()
    if (secondCheckpoint === undefined) return
    const resumed = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        checkpoint: secondCheckpoint
      })
    )

    expect(uninterrupted.status).toBe('settled')
    expect(resumed.status).toBe('settled')
    expect(resumed.checkpoint).toBeUndefined()
    expect(resumed.trace).toEqual(uninterrupted.trace)
    expect(
      resumed.endpoints.map((endpoint) => ({
        hash: endpoint.canonicalGeometryHash,
        placed: endpoint.placedPreparedIds,
        unplaced: endpoint.unplacedPreparedIds,
        objective: endpoint.metrics
      }))
    ).toEqual(
      uninterrupted.endpoints.map((endpoint) => ({
        hash: endpoint.canonicalGeometryHash,
        placed: endpoint.placedPreparedIds,
        unplaced: endpoint.unplacedPreparedIds,
        objective: endpoint.metrics
      }))
    )
  })

  it('rejects corrupted checkpoint accounting and a changed pruning incumbent', async () => {
    const pieces = [
      preparedRectangle('square-a', 60, 60),
      preparedRectangle('square-b', 60, 60),
      preparedRectangle('small', 40, 40)
    ]
    const finalSheet = sheet(110, 62)
    const materialAreasByPieceId = materialsOf(pieces)
    const complete = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map()
      })
    )
    const paused = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        maximumDepthBoundaries: 1
      })
    )
    const checkpoint = paused.checkpoint
    const incumbent = complete.endpoints[0]
    expect(checkpoint).toBeDefined()
    expect(incumbent).toBeDefined()
    if (checkpoint === undefined || incumbent === undefined) return

    const corruptedCounter = {
      ...checkpoint,
      counters: {
        ...checkpoint.counters,
        deduplicatedSuccessors: -1
      }
    }
    const counterFailure = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        checkpoint: corruptedCounter
      }).pipe(Effect.flip)
    )
    expect(counterFailure._tag).toBe('IntrinsicCapacityError')
    if (counterFailure._tag !== 'IntrinsicCapacityError') return
    expect(counterFailure.operation).toBe('coldSearchCheckpoint')

    const firstDepthLedger = checkpoint.budgetLedgers.perDepth[0]
    expect(firstDepthLedger).toBeDefined()
    if (firstDepthLedger === undefined) return
    const corruptedQuota = {
      ...checkpoint,
      budgetLedgers: {
        ...checkpoint.budgetLedgers,
        perDepth: [{ ...firstDepthLedger, quotaExhausted: true }]
      }
    }
    const quotaFailure = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        checkpoint: corruptedQuota
      }).pipe(Effect.flip)
    )
    expect(quotaFailure._tag).toBe('IntrinsicCapacityError')

    const firstFrontierEntry = checkpoint.frontier[0]
    expect(firstFrontierEntry).toBeDefined()
    if (firstFrontierEntry === undefined) return
    const corruptedCavity = {
      ...checkpoint,
      frontier: [
        {
          ...firstFrontierEntry,
          cavities: {
            ...firstFrontierEntry.cavities,
            count: firstFrontierEntry.cavities.count + 1
          }
        },
        ...checkpoint.frontier.slice(1)
      ]
    }
    const cavityFailure = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        checkpoint: corruptedCavity
      }).pipe(Effect.flip)
    )
    expect(cavityFailure._tag).toBe('IntrinsicCapacityError')
    if (cavityFailure._tag !== 'IntrinsicCapacityError') return
    expect(cavityFailure.message).toContain('integrity hash')

    const state = firstFrontierEntry.state
    const privateCorruptions: ReadonlyArray<{
      readonly property: string
      readonly value: unknown
    }> = [
      {
        property: 'canonicalEntryKeys',
        value: ['corrupted-canonical-entry']
      },
      {
        property: 'nearCompleteStructuralContactSignatureCounts',
        value: new Map([['corrupted-contact-signature', 1]])
      },
      {
        property: 'placedCollisionIndex',
        value: makePlacedCollisionSpatialIndex([])
      }
    ]
    for (const corruption of privateCorruptions) {
      const original = Object.getOwnPropertyDescriptor(state, corruption.property)
      expect(original).toBeDefined()
      Object.defineProperty(state, corruption.property, {
        configurable: true,
        enumerable: false,
        writable: false,
        value: corruption.value
      })
      const privateMetadataFailure = await provideGeometry(
        runIntrinsicCapacityColdSearch({
          sheet: finalSheet,
          preparedPieces: pieces,
          materialAreasByPieceId,
          cavityCache: new Map(),
          checkpoint
        }).pipe(Effect.flip)
      )
      expect(privateMetadataFailure._tag).toBe('IntrinsicCapacityError')
      if (privateMetadataFailure._tag === 'IntrinsicCapacityError') {
        expect(privateMetadataFailure.message).toContain('integrity hash')
      }
      if (original !== undefined) {
        Object.defineProperty(state, corruption.property, original)
      }
    }

    const incumbentFailure = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        checkpoint,
        incumbent
      }).pipe(Effect.flip)
    )
    expect(incumbentFailure._tag).toBe('IntrinsicCapacityError')
    if (incumbentFailure._tag !== 'IntrinsicCapacityError') return
    expect(incumbentFailure.message).toContain('fingerprint')
  })
})

describe('intrinsic capacity prefixes', () => {
  it('captures at most nine skip-free original-order prefixes after construction', async () => {
    const pieces = [
      preparedRectangle('square-a', 40, 40),
      preparedRectangle('square-b', 40, 40),
      preparedRectangle('square-c', 40, 40),
      preparedRectangle('square-d', 40, 40)
    ]
    expect(intrinsicCapacityPrefixDepths(pieces.length)).toEqual([1, 2, 3])
    const constructed = await provideGeometry(
      constructIntrinsicStrictState({
        allPreparedPieces: pieces,
        remainingPreparedPieces: pieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth'
      })
    )
    const descriptors = captureIntrinsicCapacityPrefixDescriptors({
      preparedPieces: pieces,
      sources: [{ role: 'canonical-grid', state: constructed.state }]
    })
    expect(descriptors).toHaveLength(3)
    for (const descriptor of descriptors) {
      expect(descriptor.role).toBe('canonical-grid')
      expect(descriptor.state.unplacedPieceIds).toEqual([])
      expect(descriptor.placedPreparedIds).toEqual(
        pieces.slice(0, descriptor.depth).map(intrinsicCapacityPreparedPieceId)
      )
      expect(descriptor.remainingPreparedIds).toEqual(
        pieces.slice(descriptor.depth).map(intrinsicCapacityPreparedPieceId)
      )
    }
  })

  it('rejects lineages that skipped a piece before the capture depth', () => {
    const pieces = [
      preparedRectangle('square-a', 40, 40),
      preparedRectangle('square-b', 40, 40),
      preparedRectangle('square-c', 40, 40),
      preparedRectangle('square-d', 40, 40)
    ]
    const skipped = IrregularBeamState.empty(pieces)
      .withUnplacedPiece({
        remainingPreparedPieces: pieces.slice(1),
        unplacedPieceId: intrinsicCapacityPreparedPieceId(pieces[0] as IrregularPreparedPiece)
      })
      .withPlacement({
        remainingPreparedPieces: pieces.slice(2),
        placedCollisionGeometry: placedRectangle(pieces[1] as IrregularPreparedPiece, 0, 0),
        placementOrderPieceId: intrinsicCapacityPreparedPieceId(
          pieces[1] as IrregularPreparedPiece
        )
      })
    const descriptors = captureIntrinsicCapacityPrefixDescriptors({
      preparedPieces: pieces,
      sources: [{ role: 'canonical-grid', state: skipped }]
    })
    expect(descriptors).toEqual([])
  })

  it('terminalizes fitting prefixes into incumbents without placement evaluations', async () => {
    const pieces = [
      preparedRectangle('square-a', 40, 40),
      preparedRectangle('square-b', 40, 40),
      preparedRectangle('square-c', 40, 40),
      preparedRectangle('square-d', 40, 40)
    ]
    const constructed = await provideGeometry(
      constructIntrinsicStrictState({
        allPreparedPieces: pieces,
        remainingPreparedPieces: pieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth'
      })
    )
    const descriptors = captureIntrinsicCapacityPrefixDescriptors({
      preparedPieces: pieces,
      sources: [{ role: 'canonical-grid', state: constructed.state }]
    })
    const terminalization = terminalizeIntrinsicCapacityPrefixEndpoints({
      sheet: sheet(90, 45),
      descriptors,
      materialAreasByPieceId: materialsOf(pieces),
      cavityCache: new Map()
    })
    expect(terminalization.capturedCount).toBe(3)
    expect(terminalization.fittingCount).toBeGreaterThanOrEqual(1)
    const incumbent = terminalization.incumbent
    expect(incumbent).toBeDefined()
    if (incumbent === undefined) return
    expect(incumbent.origin).toBe('prefix-incumbent')
    expect(
      intrinsicCapacityEndpointPartitionsRequest(
        incumbent,
        pieces.map(intrinsicCapacityPreparedPieceId)
      )
    ).toBe(true)
  })

  it('resumes an exact warm prefix with the uninterrupted trace and endpoint', async () => {
    const pieces = [
      preparedRectangle('square-a', 40, 40),
      preparedRectangle('square-b', 40, 40),
      preparedRectangle('square-c', 40, 40),
      preparedRectangle('square-d', 40, 40)
    ]
    const finalSheet = sheet(90, 45)
    const materialAreasByPieceId = materialsOf(pieces)
    const constructed = await provideGeometry(
      constructIntrinsicStrictState({
        allPreparedPieces: pieces,
        remainingPreparedPieces: pieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth'
      })
    )
    const descriptors = captureIntrinsicCapacityPrefixDescriptors({
      preparedPieces: pieces,
      sources: [{ role: 'canonical-grid', state: constructed.state }]
    })
    const terminalization = terminalizeIntrinsicCapacityPrefixEndpoints({
      sheet: finalSheet,
      descriptors,
      materialAreasByPieceId,
      cavityCache: new Map()
    })
    const descriptor = terminalization.fittingDescriptors[0]
    expect(descriptor).toBeDefined()
    if (descriptor === undefined) return
    const warmPrefixSeed = {
      sourceRole: descriptor.role,
      depth: descriptor.depth,
      state: descriptor.state
    }
    const uninterrupted = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        warmPrefixSeed
      })
    )
    const paused = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        warmPrefixSeed,
        maximumDepthBoundaries: 1
      })
    )
    expect(paused.status).toBe('paused')
    expect(paused.checkpoint?.producerRole).toBe('capacity-warm-prefix')
    expect(paused.checkpoint?.nextDepth).toBe(descriptor.depth + 1)
    const checkpoint = paused.checkpoint
    expect(checkpoint).toBeDefined()
    if (checkpoint === undefined) return
    const firstFrontierEntry = checkpoint.frontier[0]
    expect(firstFrontierEntry).toBeDefined()
    if (firstFrontierEntry === undefined) return
    const corruptedCavity = {
      ...checkpoint,
      frontier: [
        {
          ...firstFrontierEntry,
          cavities: {
            ...firstFrontierEntry.cavities,
            totalAreaMm2: firstFrontierEntry.cavities.totalAreaMm2 + 1
          }
        },
        ...checkpoint.frontier.slice(1)
      ]
    }
    const cavityFailure = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        warmPrefixSeed,
        checkpoint: corruptedCavity
      }).pipe(Effect.flip)
    )
    expect(cavityFailure._tag).toBe('IntrinsicCapacityError')
    if (cavityFailure._tag !== 'IntrinsicCapacityError') return
    expect(cavityFailure.message).toContain('integrity hash')
    const resumed = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        warmPrefixSeed,
        checkpoint
      })
    )
    expect(resumed.trace).toEqual(uninterrupted.trace)
    expect(resumed.endpoints).toEqual(uninterrupted.endpoints)
    expect(
      resumed.endpoints.every(({ origin }) => origin === 'warm-prefix-continuation')
    ).toBe(true)

    const qualityUninterrupted = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        warmPrefixSeed,
        retentionMode: 'quality-frontier'
      })
    )
    const qualityPaused = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        warmPrefixSeed,
        retentionMode: 'quality-frontier',
        maximumDepthBoundaries: 1
      })
    )
    expect(qualityPaused.checkpoint?.producerRole).toBe(
      'capacity-quality-warm-prefix'
    )
    const qualityCheckpoint = qualityPaused.checkpoint
    expect(qualityCheckpoint).toBeDefined()
    if (qualityCheckpoint === undefined) return
    const qualityResumed = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        warmPrefixSeed,
        retentionMode: 'quality-frontier',
        checkpoint: qualityCheckpoint
      })
    )
    expect(qualityResumed.trace).toEqual(qualityUninterrupted.trace)
    expect(qualityResumed.endpoints).toEqual(qualityUninterrupted.endpoints)
    const crossRoleFailure = await provideGeometry(
      runIntrinsicCapacityColdSearch({
        sheet: finalSheet,
        preparedPieces: pieces,
        materialAreasByPieceId,
        cavityCache: new Map(),
        warmPrefixSeed,
        retentionMode: 'quality-frontier',
        checkpoint
      }).pipe(Effect.flip)
    )
    expect(crossRoleFailure._tag).toBe('IntrinsicCapacityError')
    if (crossRoleFailure._tag === 'IntrinsicCapacityError') {
      expect(crossRoleFailure.message).toContain('fingerprint')
    }
  })

  it('matches cold-only output exactly when no descriptor is captured', async () => {
    const pieces = [
      preparedRectangle('square-a', 60, 60),
      preparedRectangle('square-b', 60, 60),
      preparedRectangle('square-c', 60, 60),
      preparedRectangle('square-d', 60, 60)
    ]
    const skippedLineage = IrregularBeamState.empty(pieces).withUnplacedPiece({
      remainingPreparedPieces: pieces.slice(1),
      unplacedPieceId: intrinsicCapacityPreparedPieceId(pieces[0] as IrregularPreparedPiece)
    })
    const withUselessSource = await runMode({
      sheet: sheet(100, 100),
      preparedPieces: pieces,
      prefixSources: [{ role: 'canonical-grid', state: skippedLineage }]
    })
    const coldOnly = await runMode({
      sheet: sheet(100, 100),
      preparedPieces: pieces,
      prefixSources: [],
      disablePrefixReuse: true
    })
    expect(withUselessSource.trace.prefixes.capturedCount).toBe(0)
    expect(withUselessSource.endpoint.canonicalGeometryHash).toBe(
      coldOnly.endpoint.canonicalGeometryHash
    )
    expect(withUselessSource.trace.coldSearch).toEqual(coldOnly.trace.coldSearch)
  })

  it('never ranks prefix-enabled output below cold-only output', async () => {
    const pieces = [
      preparedRectangle('square-a', 40, 40),
      preparedRectangle('square-b', 40, 40),
      preparedRectangle('square-c', 40, 40),
      preparedRectangle('square-d', 40, 40)
    ]
    const constructed = await provideGeometry(
      constructIntrinsicStrictState({
        allPreparedPieces: pieces,
        remainingPreparedPieces: pieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth'
      })
    )
    const constrainedSheet = sheet(90, 45)
    const prefixEnabled = await runMode({
      sheet: constrainedSheet,
      preparedPieces: pieces,
      prefixSources: [{ role: 'canonical-grid', state: constructed.state }]
    })
    const coldOnly = await runMode({
      sheet: constrainedSheet,
      preparedPieces: pieces,
      prefixSources: [],
      disablePrefixReuse: true
    })
    expect(
      compareIntrinsicCapacityEndpoints(prefixEnabled.endpoint, coldOnly.endpoint)
    ).toBeLessThanOrEqual(0)
  })
})

describe('experimental place/defer complete shadow', () => {
  it('resumes the defer boundary with the uninterrupted trace and endpoint', async () => {
    const pieces = [
      preparedRectangle('deferred-a', 20, 10),
      preparedRectangle('pending-b', 15, 10),
      preparedRectangle('pending-c', 10, 10)
    ]
    const finalSheet = sheet(200, 200)
    const uninterrupted = await provideGeometry(
      runIntrinsicPlaceDeferCompleteShadow({
        sheet: finalSheet,
        preparedPieces: pieces
      })
    )
    const paused = await provideGeometry(
      runIntrinsicPlaceDeferCompleteShadow({
        sheet: finalSheet,
        preparedPieces: pieces,
        maximumDecisionBoundaries: 1
      })
    )
    expect(paused.status).toBe('paused')
    expect(paused.checkpoint?.placedPreparedIds).toEqual([])
    expect(paused.checkpoint?.pendingPreparedIds).toEqual(['pending-b', 'pending-c'])
    expect(paused.checkpoint?.deferredPreparedIds).toEqual(['deferred-a'])
    expect(paused.checkpoint?.permanentlySkippedPreparedIds).toEqual([])
    expect(paused.checkpoint?.pendingOrder).toEqual([
      'pending-b',
      'pending-c',
      'deferred-a'
    ])
    const checkpoint = paused.checkpoint
    expect(checkpoint).toBeDefined()
    if (checkpoint === undefined) return
    const resumed = await provideGeometry(
      runIntrinsicPlaceDeferCompleteShadow({
        sheet: finalSheet,
        preparedPieces: pieces,
        checkpoint
      })
    )
    expect(resumed.trace).toEqual(uninterrupted.trace)
    expect(resumed.endpoint).toEqual(uninterrupted.endpoint)
    expect(resumed.trace.status).toBe('completed')
    expect(resumed.trace.outputInfluence).toBe('none')
    expect(resumed.endpoint?.placedCollisionGeometries).toHaveLength(pieces.length)
  })

  it('rejects a checkpoint whose future defer decision state changed', async () => {
    const pieces = [
      preparedRectangle('deferred-a', 20, 10),
      preparedRectangle('pending-b', 15, 10)
    ]
    const finalSheet = sheet(200, 200)
    const paused = await provideGeometry(
      runIntrinsicPlaceDeferCompleteShadow({
        sheet: finalSheet,
        preparedPieces: pieces,
        maximumDecisionBoundaries: 1
      })
    )
    const checkpoint = paused.checkpoint
    expect(checkpoint).toBeDefined()
    if (checkpoint === undefined) return
    await expect(
      provideGeometry(
        runIntrinsicPlaceDeferCompleteShadow({
          sheet: finalSheet,
          preparedPieces: pieces,
          checkpoint: {
            ...checkpoint,
            pendingPreparedIds: [PieceId.make('deferred-a')],
            deferredPreparedIds: [PieceId.make('pending-b')],
            pendingOrder: [PieceId.make('deferred-a'), PieceId.make('pending-b')],
            deferralCounts: { 'pending-b': 1 }
          }
        })
      )
    ).rejects.toMatchObject({
      _tag: 'IntrinsicCapacityError',
      operation: 'placeDeferCheckpoint'
    })
  })

  it('censors bounded observer failures but preserves explicit cancellation', async () => {
    const pieces = [
      preparedRectangle('deferred-a', 20, 10),
      preparedRectangle('pending-b', 15, 10)
    ]
    const finalSheet = sheet(200, 200)
    const deadline = await provideGeometry(
      observeIntrinsicPlaceDeferCompleteShadow({
        sheet: finalSheet,
        preparedPieces: pieces,
        control: {
          checkpoint: () =>
            Effect.fail(
              new IrregularNfpIfpControlAbortError({
                reason: 'deadline',
                message: 'isolated shadow deadline'
              })
            )
        }
      })
    )
    expect(deadline.endpoint).toBeUndefined()
    expect(deadline.trace.status).toBe('censored')
    expect(deadline.trace.censoringReason).toBe('deadline')
    expect(deadline.trace.outputInfluence).toBe('none')

    await expect(
      provideGeometry(
        observeIntrinsicPlaceDeferCompleteShadow({
          sheet: finalSheet,
          preparedPieces: pieces,
          control: {
            checkpoint: () =>
              Effect.fail(
                new IrregularNfpIfpControlAbortError({
                  reason: 'cancelled',
                  message: 'explicit user cancellation'
                })
              )
          }
        })
      )
    ).rejects.toMatchObject({
      _tag: 'IrregularNfpIfpControlAbortError',
      reason: 'cancelled'
    })
  })
})

describe('capacity prefix capture isolation', () => {
  it('does not change direct construction, evaluations, or endpoint hashes', async () => {
    const pieces = [
      preparedRectangle('square-a', 40, 40),
      preparedRectangle('square-b', 40, 40),
      preparedRectangle('square-c', 40, 40)
    ]
    const projection = (
      runs: Awaited<ReturnType<typeof runDirect>>
    ): ReadonlyArray<Record<string, unknown>> =>
      runs.map((run) => ({
        role: run.role,
        status: run.status,
        consumedCandidateEvaluations: run.consumedCandidateEvaluations,
        hash: run.endpoint?.sheetlessCanonicalGeometryHash
      }))
    function runDirect(withCapture: boolean) {
      const captured: string[] = []
      return provideGeometry(
        runIntrinsicSharedArchiveDirectPortfolio(sheet(2000, 2700), pieces, {
          ...(withCapture
            ? {
                onDirectConstructed: (role: string) => {
                  captured.push(role)
                }
              }
            : {})
        })
      )
    }
    const without = await runDirect(false)
    const withCapture = await runDirect(true)
    expect(projection(withCapture)).toEqual(projection(without))
  })

  it('keeps the complete portfolio identical through canonical-grid checkpoints', async () => {
    const pieces = [
      preparedRectangle('square-a', 40, 40, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('square-b', 40, 40, [transform(0, 0), transform(1, 90)]),
      preparedRectangle('square-c', 40, 40, [transform(0, 0), transform(1, 90)])
    ]
    const run = async (checkpointed: boolean) => {
      const completed: string[] = []
      const checkpoints: number[] = []
      const result = await provideGeometry(
        runIntrinsicSharedArchivePortfolio(sheet(2000, 2700), pieces, {
          ...(checkpointed
            ? {
                canonicalGridCompletedPieceQuantum: 1,
                onCanonicalGridCheckpointed: (checkpoint) => {
                  checkpoints.push(checkpoint.nextPieceIndex)
                  return Effect.void
                }
              }
            : {}),
          onDirectConstructed: (role, state) => {
            completed.push(`${role}:${state.canonicalOccupiedGeometryKey}`)
          }
        })
      )
      return {
        checkpoints,
        completed,
        direct: result.directRuns.map((directRun) => ({
          role: directRun.role,
          status: directRun.status,
          evaluations: directRun.consumedCandidateEvaluations,
          hash: directRun.endpoint?.sheetlessCanonicalGeometryHash
        })),
        periodic: result.periodicRuns.map((periodicRun) => ({
          role: periodicRun.role,
          sourceId: periodicRun.sourceId,
          status: periodicRun.status,
          evaluations: periodicRun.consumedCandidateEvaluations,
          hash: periodicRun.endpoint?.sheetlessCanonicalGeometryHash
        })),
        periodicCoverage: {
          catalogRuntimeCoverageComplete:
            result.periodicPortfolio.catalog.runtimeCoverageComplete,
          familyCoverageComplete:
            result.periodicPortfolio.catalog.familyCoverageComplete,
          continuationCoverageComplete:
            result.periodicPortfolio.continuationCoverageComplete,
          budgetSettlementComplete:
            result.periodicPortfolio.continuationBudgetSettlementComplete
        },
        sheetlessArchive: result.sheetlessArchive.map(
          ({ sheetlessCanonicalGeometryHash }) => sheetlessCanonicalGeometryHash
        ),
        archive: result.archive.map(
          ({ sheetlessCanonicalGeometryHash }) => sheetlessCanonicalGeometryHash
        ),
        winner: result.winner?.sheetlessCanonicalGeometryHash
      }
    }

    const uninterrupted = await run(false)
    const checkpointed = await run(true)

    expect(checkpointed.checkpoints).toEqual([1, 2])
    expect({ ...checkpointed, checkpoints: [] }).toEqual(uninterrupted)
  })
})
