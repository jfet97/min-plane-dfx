import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect, RectWith } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import {
  NestingOptions,
  NestingRequest,
  SheetSpec,
  PreparedPiece
} from '@shared/domain/nesting.js'
import { IrregularNestingSettings, IrregularOptimizerSettings } from '@shared/irregular/domain.js'
import { GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { FreeMaterialServiceLive } from '../../src/workers/irregular/freeMaterialService.js'
import {
  IrregularComputeError,
  type ComputeIrregularNestingOptions,
  computeIrregularNesting
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { makeIrregularWorkerOutput } from '../../src/workers/algorithm/irregular/irregularWorkerOutput.js'
import { IrregularLayoutScorer } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'

const geometrySettings = new IrregularNestingSettings({
  geometry: {
    flatteningSagToleranceMm: 0.25,
    clearanceSafetyMarginMm: 0.25,
    geometryBackendId: 'test',
    geometryBackendVersion: '1'
  },
  optimizer: new IrregularOptimizerSettings({
    orderWindow: 1,
    beamWidth: 2,
    transformCap: 4,
    transformMinimumEdgeLengthMm: 0,
    transformAngleDeduplicationToleranceDeg: 0.01,
    configuredRotationDeg: [],
    gaPopulation: 1,
    gaTimeBudgetMs: 1,
    gaSeed: 'test'
  })
})

function run(request: NestingRequest, options?: ComputeIrregularNestingOptions) {
  return computeIrregularNesting(request, options).pipe(
    Effect.provide(CollisionGeometryBuilder.Live),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(NfpIfpServiceLive),
    Effect.provide(FreeMaterialServiceLive),
    Effect.provide(IrregularPlacementScorer.Live),
    Effect.provide(IrregularLayoutScorer.Live),
    Effect.provide(Layer.succeed(GeometrySettings, geometrySettings))
  )
}

function source(id: string): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`file-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width: 2, height: 2 }),
    geometry: new DxfGeometrySummary({
      entityType: 'LWPOLYLINE',
      closed: true,
      segments: [
        { kind: 'line', x1: 0, y1: 0, x2: 2, y2: 0 },
        { kind: 'line', x1: 2, y1: 0, x2: 2, y2: 2 },
        { kind: 'line', x1: 2, y1: 2, x2: 0, y2: 2 },
        { kind: 'line', x1: 0, y1: 2, x2: 0, y2: 0 }
      ]
    }),
    warnings: []
  })
}

function prepared(id: string, sourcePieceId = id): PreparedPiece {
  const realBounds = new Rect({ x: 0, y: 0, width: 2, height: 2 })
  return new PreparedPiece({
    id: PieceId.make(id),
    sourcePieceId: PieceId.make(sourcePieceId),
    realBounds,
    paddedBounds: new RectWith({
      ...realBounds,
      longestEdge: 2,
      area: 4,
      imbalance: 0
    }),
    padding: 0,
    allowRotation: true
  })
}

function request(pieces: ReadonlyArray<PreparedPiece>, sourcePieces?: ReadonlyArray<ImportedPiece>) {
  return new NestingRequest({
    version: 1,
    sheet: new SheetSpec({ width: 10, height: 10, label: 'test sheet' }),
    padding: 0,
    pieces,
    ...(sourcePieces === undefined ? {} : { sourcePieces }),
    options: new NestingOptions({
      allowGlobalRotation: true,
      timeoutMs: 1000,
      workerMode: 'irregular-convex-v2',
      historyMode: 'off',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: [],
      layoutSelectionStrategyId: 'compact-first',
      finalSelectionMode: 'best'
    })
  })
}

describe('computeIrregularNesting', () => {
  it('builds real collision geometry from a tiny closed DXF outline', async () => {
    const result = await Effect.runPromise(run(request([prepared('piece')], [source('piece')])))

    expect(result.sortedPieceIds).toEqual([PieceId.make('piece')])
    expect(result.placedCollisionGeometries).toHaveLength(1)
    expect(result.placedCollisionGeometries[0]?.collisionGeometry.polygon.points.length).toBeGreaterThan(2)
    expect(result.score.placementOrder).toEqual([PieceId.make('piece')])
  })

  it('fails with a typed error when source geometry is missing', async () => {
    const failure = await Effect.runPromise(
      run(request([prepared('missing')])).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => undefined
        })
      )
    )

    expect(failure).toBeInstanceOf(IrregularComputeError)
    expect(failure?._tag).toBe('IrregularComputeError')
  })

  it('uses copy-id fallback and records actual beam state progression', async () => {
    const result = await Effect.runPromise(
      run(request([prepared('piece-copy-1', 'piece-copy-1')], [source('piece')]))
    )

    expect(result.placedCollisionGeometries[0]?.placement.pieceId).toBe(PieceId.make('piece-copy-1'))
    expect(result.placedCollisionGeometries[0]?.placement.sourcePieceId).toBe(PieceId.make('piece'))
    expect(result.stateSnapshots[0]?.state.placedCollisionGeometries).toHaveLength(0)
    expect(result.stateSnapshots.at(-1)?.state.placedCollisionGeometries).toHaveLength(1)
  })

  it('keeps real transform placements and tagged beam history at the worker boundary', async () => {
    const nestingRequest = request([prepared('piece-copy-1', 'piece-copy-1')], [source('piece')])
    const emittedStepIndexes: number[] = []
    const computed = await Effect.runPromise(
      run(nestingRequest, {
        emitStateSnapshot: (snapshot) => {
          emittedStepIndexes.push(snapshot.stepIndex)
        }
      })
    )
    const output = makeIrregularWorkerOutput({
      request: nestingRequest,
      computed,
      algorithmBenchmark: {
        startedAt: '2026-07-15T12:00:00.000Z',
        endedAt: '2026-07-15T12:00:00.010Z',
        elapsedMs: 10
      }
    })
    const layout = output.result.layout

    if (layout === undefined || layout.kind !== 'irregular') {
      throw new Error('expected an irregular layout')
    }

    expect(output.result.placements).toEqual([])
    expect(layout.placements[0]?.pieceId).toBe(PieceId.make('piece-copy-1'))
    expect(layout.placements[0]?.sourcePieceId).toBe(PieceId.make('piece'))
    expect(layout.placements[0]?.placementReference).toBeDefined()
    const summaryLayout = output.result.runSummary?.subRuns[0]?.layout
    expect(summaryLayout?.kind).toBe('irregular')
    if (summaryLayout?.kind === 'irregular') {
      expect(summaryLayout.placements[0]?.transform).toEqual(layout.placements[0]?.transform)
    }
    expect(output.historyFrames[0]?.kind).toBe('irregular')
    expect(output.historyFrames[0]?.remainingPieceIds).toEqual([PieceId.make('piece-copy-1')])
    expect(output.historyFrames.at(-1)?.placements).toHaveLength(1)
    expect(emittedStepIndexes).toEqual(output.historyFrames.map((frame) => frame.stepIndex))
  })
})
