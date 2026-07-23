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
import { runIntrinsicCapacityColdSearch } from '../../src/workers/algorithm/irregular/intrinsicCapacitySearch.js'
import { constructIntrinsicStrictState } from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import { runIntrinsicSharedArchiveDirectPortfolio } from '../../src/workers/algorithm/irregular/intrinsicSharedArchivePortfolio.js'
import { IrregularBeamState } from '../../src/workers/algorithm/irregular/irregularBeamState.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
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
})

describe('intrinsic capacity search', () => {
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
})
