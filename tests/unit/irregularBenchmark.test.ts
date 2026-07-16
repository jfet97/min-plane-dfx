import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importDxfFile } from '@main/services/DxfImportService.js'
import { ImportedPiece, ImportWarning } from '@shared/domain/dxf.js'
import { NestingOptions, NestingRequest, SheetSpec } from '@shared/domain/nesting.js'
import { JobId } from '@shared/domain/ids.js'
import { IrregularNestingSettings, IrregularOptimizerSettings } from '@shared/irregular/domain.js'
import { preparePieces } from '@shared/preparePieces.js'
import { computeNesting } from '../../src/workers/algorithm/computeNesting.js'
import {
  computeIrregularNesting,
  type IrregularComputeResult
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { makeIrregularWorkerOutput } from '../../src/workers/algorithm/irregular/irregularWorkerOutput.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { FreeMaterialServiceLive } from '../../src/workers/irregular/freeMaterialService.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'
import { IrregularLayoutScorer } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { IrregularGeometryInputError } from '../../src/workers/irregular/services.js'
import { DEFAULT_STRATEGY_ID } from '@shared/domain/strategies.js'
import { normalizeImportedPieceIdentities } from '../../scripts/irregular-benchmark.js'
import {
  collisionOpportunityMetrics,
  repeatImportedPieces
} from '../fixtures/irregularBenchmarkFixtures.js'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const fixturesDir = join(repoRoot, 'tests', 'fixtures', 'dxf')

function experimentSettings(
  optimizer: Partial<ConstructorParameters<typeof IrregularOptimizerSettings>[0]> = {}
): IrregularNestingSettings {
  return new IrregularNestingSettings({
    geometry: {
      flatteningSagToleranceMm: 0.25,
      clearanceSafetyMarginMm: 0.25,
      geometryBackendId: 'benchmark-test',
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
      gaSeed: 'benchmark-seed',
      ...optimizer
    })
  })
}

const geometrySettings = experimentSettings()

function importFixture(name: string): Promise<ImportedPiece> {
  return importDxfFile(join(fixturesDir, name)).then((document) => {
    const piece = document.pieces[0]
    if (piece === undefined) throw new Error(`fixture ${name} imported without a piece`)
    return piece
  })
}

function identityKey(piece: ImportedPiece): { id: ImportedPiece['id']; sourceFileId: ImportedPiece['sourceFileId'] } {
  return { id: piece.id, sourceFileId: piece.sourceFileId }
}

function requestFor(
  sources: ReadonlyArray<ImportedPiece>,
  sheet: SheetSpec,
  padding: number,
  workerMode: 'maxrects-beam-search' | 'irregular-convex-v2',
  experiment: {
    readonly settings?: IrregularNestingSettings
    readonly allowGlobalRotation?: boolean
    readonly allowGlobalMirror?: boolean
  } = {}
): NestingRequest {
  const prepared = preparePieces(sources, sheet, padding, JobId.make('benchmark-job')).pieces
  return new NestingRequest({
    version: 1,
    jobId: JobId.make('benchmark-job'),
    sheet,
    padding,
    pieces: prepared,
    sourcePieces: sources,
    options: new NestingOptions({
      allowGlobalRotation: experiment.allowGlobalRotation ?? true,
      allowGlobalMirror: experiment.allowGlobalMirror ?? true,
      timeoutMs: 1000,
      workerMode,
      historyMode: 'final',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: [DEFAULT_STRATEGY_ID],
      layoutSelectionStrategyId: 'compact-first',
      finalSelectionMode: 'best',
      ...(experiment.settings !== undefined ? { irregularSettings: experiment.settings } : {})
    })
  })
}

function runIrregular(request: NestingRequest) {
  const settings = request.options.irregularSettings ?? geometrySettings
  return computeIrregularNesting(request).pipe(
    Effect.provide(CollisionGeometryBuilder.Live),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(NfpIfpServiceLive),
    Effect.provide(FreeMaterialServiceLive),
    Effect.provide(IrregularPlacementScorer.Live),
    Effect.provide(IrregularLayoutScorer.Live),
    Effect.provide(Layer.succeed(GeometrySettings, settings))
  )
}

function runRectangular(request: NestingRequest) {
  return computeNesting(request, { emitFrame: () => {} })
}

function rectangularUsedBoundsArea(
  placements: ReadonlyArray<{ x: number; y: number; width: number; height: number }>
): number {
  const first = placements[0]
  if (first === undefined) return 0
  let minX = first.x
  let minY = first.y
  let maxX = first.x + first.width
  let maxY = first.y + first.height
  for (const placement of placements.slice(1)) {
    minX = Math.min(minX, placement.x)
    minY = Math.min(minY, placement.y)
    maxX = Math.max(maxX, placement.x + placement.width)
    maxY = Math.max(maxY, placement.y + placement.height)
  }
  return (maxX - minX) * (maxY - minY)
}

function placementKey(
  placement: IrregularComputeResult['placedCollisionGeometries'][number]['placement']
) {
  return {
    pieceId: placement.pieceId,
    sourcePieceId: placement.sourcePieceId,
    placementReference: placement.placementReference,
    transform: placement.transform
  }
}

function placementKeyString(
  placement: IrregularComputeResult['placedCollisionGeometries'][number]['placement']
): string {
  return JSON.stringify(placementKey(placement))
}

function computeKey(result: IrregularComputeResult) {
  return {
    placements: result.placedCollisionGeometries.map(({ placement }) => placementKey(placement)),
    unplacedPieceIds: result.unplacedPieceIds,
    sortedPieceIds: result.sortedPieceIds,
    diagnostics: result.diagnostics,
    score: result.score,
    snapshots: result.stateSnapshots.map((snapshot) => ({
      stepIndex: snapshot.stepIndex,
      beamRank: snapshot.beamRank,
      candidateCount: snapshot.candidateCount,
      remainingPieceIds: snapshot.state.remainingPreparedPieces.map(
        (piece) => piece.pieceId ?? piece.source.id
      ),
      placementOrder: snapshot.state.placementOrder,
      unplacedPieceIds: snapshot.state.unplacedPieceIds,
      placements: snapshot.state.placedCollisionGeometries.map(({ placement }) =>
        placementKey(placement)
      )
    }))
  }
}

describe('irregular benchmark and debug corpus', () => {
  it('normalizes imported identities before deterministic repetition', async () => {
    const fixtureNames = ['triangle.dxf', 'trapezoid.dxf', 'triangle.dxf']
    const firstImported = await Promise.all(fixtureNames.map(importFixture))
    const secondImported = await Promise.all(fixtureNames.map(importFixture))
    const firstSources = normalizeImportedPieceIdentities(fixtureNames, firstImported)
    const secondSources = normalizeImportedPieceIdentities(fixtureNames, secondImported)

    expect(firstSources.map(identityKey)).toEqual(secondSources.map(identityKey))
    expect(new Set(firstSources.map((source) => source.id)).size).toBe(fixtureNames.length)
    expect(new Set(firstSources.map((source) => source.sourceFileId)).size).toBe(fixtureNames.length)
    expect(firstSources[0]?.id).not.toBe(firstSources[1]?.id)
    expect(firstSources[0]?.sourceFileId).not.toBe(firstSources[1]?.sourceFileId)

    const firstCopies = repeatImportedPieces(firstSources, 2)
    const secondCopies = repeatImportedPieces(secondSources, 2)
    expect(firstCopies.map(identityKey)).toEqual(secondCopies.map(identityKey))

    const original = firstImported[0]
    const normalized = firstSources[0]
    if (original === undefined || normalized === undefined) {
      throw new Error('expected triangle fixture to import')
    }
    expect({
      sourceLayer: normalized.sourceLayer,
      label: normalized.label,
      realBounds: normalized.realBounds,
      geometry: normalized.geometry,
      warnings: normalized.warnings
    }).toEqual({
      sourceLayer: original.sourceLayer,
      label: original.label,
      realBounds: original.realBounds,
      geometry: original.geometry,
      warnings: original.warnings
    })
  })

  it('reports a truthful convex opportunity against the rectangular footprint', async () => {
    const sources = await Promise.all([
      importFixture('triangle.dxf'),
      importFixture('trapezoid.dxf'),
      importFixture('star-5-point.dxf')
    ])
    const request = requestFor(
      sources,
      new SheetSpec({ width: 260, height: 100, label: 'benchmark' }),
      0,
      'irregular-convex-v2'
    )
    const geometries = await Effect.runPromise(
      CollisionGeometryBuilder.use((builder) =>
        Effect.forEach(sources, (piece) => builder.buildPiece({ piece, totalPaddingMm: 0 }))
      ).pipe(
        Effect.provide(CollisionGeometryBuilder.Live),
        Effect.provide(Layer.succeed(GeometrySettings, geometrySettings))
      )
    )

    const metrics = geometries.map(collisionOpportunityMetrics)
    expect(metrics.every((metric) => metric.convexHullToBoundingBoxRatio > 0)).toBe(true)
    expect(metrics.every((metric) => metric.convexHullToBoundingBoxRatio <= 1)).toBe(true)
    expect(metrics.every((metric) => metric.collisionPolygonToPaddedBoundingBoxRatio > 0)).toBe(
      true
    )
    expect(metrics[0]?.convexHullToBoundingBoxRatio).toBeCloseTo(0.5, 10)
    expect(metrics[1]?.convexHullToBoundingBoxRatio).toBeCloseTo(0.7391304348, 10)
    expect(metrics[2]?.convexHullToBoundingBoxRatio).toBeLessThan(0.8)
    expect(request.pieces).toHaveLength(3)
  })

  it('keeps repeated mixed runs comparable to rectangular MaxRects', async () => {
    const baseSources = await Promise.all([
      importFixture('triangle.dxf'),
      importFixture('trapezoid.dxf')
    ])
    const repeatedSources = repeatImportedPieces(baseSources, 2)
    expect(repeatedSources).toHaveLength(4)
    expect(new Set(repeatedSources.map((source) => source.id)).size).toBe(4)
    const sources = repeatImportedPieces(baseSources, 1)
    const sheet = new SheetSpec({ width: 260, height: 100, label: 'repeated benchmark' })
    const irregularRequest = requestFor(sources, sheet, 0, 'irregular-convex-v2')
    const rectangularRequest = requestFor(sources, sheet, 0, 'maxrects-beam-search')
    const irregular = await Effect.runPromise(runIrregular(irregularRequest))
    const rectangular = runRectangular(rectangularRequest)
    const comparison = {
      irregular: {
        placedCount: irregular.placedCollisionGeometries.length,
        unplacedCount: irregular.unplacedPieceIds.length,
        usedBoundsAreaMm2: irregular.score.collisionBoundsAreaMm2
      },
      rectangular: {
        placedCount: rectangular.placements.length,
        unplacedCount: rectangular.unplacedPieceIds.length,
        usedBoundsAreaMm2: rectangularUsedBoundsArea(rectangular.placements)
      }
    }

    expect(comparison.irregular.unplacedCount).toBeLessThanOrEqual(sources.length)
    expect(irregular.placedCollisionGeometries.length).toBe(irregular.score.placementOrder.length)
    expect(new Set(irregular.score.placementOrder).size).toBe(irregular.score.placementOrder.length)
    expect(comparison.irregular.placedCount).toBeGreaterThanOrEqual(
      comparison.rectangular.placedCount
    )
    expect(comparison.irregular.usedBoundsAreaMm2).toBeGreaterThan(0)
    expect(comparison.rectangular.usedBoundsAreaMm2).toBeGreaterThan(0)
    expect(irregular.diagnostics.every(({ message }) => message.length > 0)).toBe(true)
  })

  it('is repeatable without timing-sensitive assertions or fabricated history', async () => {
    const baseSources = await Promise.all([
      importFixture('triangle.dxf'),
      importFixture('trapezoid.dxf')
    ])
    const sources = repeatImportedPieces(baseSources, 1)
    const request = requestFor(
      sources,
      new SheetSpec({ width: 260, height: 100, label: 'repeatability benchmark' }),
      2,
      'irregular-convex-v2'
    )
    const first = await Effect.runPromise(runIrregular(request))
    const second = await Effect.runPromise(runIrregular(request))
    expect(computeKey(first)).toEqual(computeKey(second))

    const output = makeIrregularWorkerOutput({
      request,
      computed: first,
      algorithmBenchmark: {
        startedAt: '2026-07-15T12:00:00.000Z',
        endedAt: '2026-07-15T12:00:00.001Z',
        elapsedMs: 1
      }
    })
    const layout = output.result.layout
    if (layout === undefined || layout.kind !== 'irregular') {
      throw new Error('expected a real irregular layout')
    }
    expect(output.result.placements).toEqual([])
    expect(layout.placements.map(placementKey)).toEqual(
      first.placedCollisionGeometries.map(({ placement }) => placementKey(placement))
    )
    expect(output.historyFrames.at(-1)?.placements.map(placementKey)).toEqual(
      layout.placements.map(placementKey)
    )
    expect(output.historyFrames.at(-1)?.unplacedPieceIds).toEqual(layout.unplacedPieceIds)
    expect(
      output.historyFrames.every((frame) =>
        frame.placements.every((placement) =>
          layout.placements.some(
            (finalPlacement) => placementKeyString(finalPlacement) === placementKeyString(placement)
          )
        )
      )
    ).toBe(true)
  })

  it('keeps a restricted experiment row reproducible when degrees of freedom are disabled', async () => {
    const sources = await Promise.all([importFixture('triangle.dxf'), importFixture('trapezoid.dxf')])
    const restrictedSettings = experimentSettings({
      orderWindow: 1,
      beamWidth: 1,
      localCandidateFanout: 1,
      transformCap: 1,
      configuredRotationEnabled: false,
      configuredRotationDeg: [45],
      gaEnabled: false,
      baselineOnly: true,
      gaGenerationBudget: 0,
      gaEvaluationBudget: 0,
      gaTimeBudgetMs: 0,
      priorityOrderMutationEnabled: false,
      transformPreferenceMutationEnabled: false,
      placementPolicyMutationEnabled: false,
      placementPolicyId: 'balanced-compactness',
      placementPolicyIds: ['balanced-compactness']
    })
    const nestingRequest = requestFor(
      sources,
      new SheetSpec({ width: 260, height: 100, label: 'restricted experiment' }),
      0,
      'irregular-convex-v2',
      {
        settings: restrictedSettings,
        allowGlobalRotation: false,
        allowGlobalMirror: false
      }
    )

    const first = await Effect.runPromise(runIrregular(nestingRequest))
    const second = await Effect.runPromise(runIrregular(nestingRequest))

    expect(first.portfolio.source).toBe('beam')
    expect(first.portfolio.status).toBe('completed')
    expect(first.placedCollisionGeometries.every(({ placement }) => !placement.transform.mirrored)).toBe(
      true
    )
    expect(first.placedCollisionGeometries.every(({ placement }) => placement.transform.rotationDeg === 0)).toBe(
      true
    )
    expect(computeKey(second)).toEqual(computeKey(first))
  })

  it('validates stress fixtures directly and preserves import warnings', async () => {
    const validStressSources = await Promise.all([
      importFixture('near-collinear.dxf'),
      importFixture('tiny-segments.dxf'),
      importFixture('duplicate-points.dxf'),
      importFixture('high-padding.dxf'),
      importFixture('angled-profile.dxf')
    ])
    const stressOutcomes = await Effect.runPromise(
      CollisionGeometryBuilder.use((builder) =>
        Effect.forEach(validStressSources, (piece) =>
          builder.buildPiece({ piece, totalPaddingMm: 40 }).pipe(
            Effect.match({
              onFailure: (error) => ({ kind: 'failure' as const, error }),
              onSuccess: (geometry) => ({ kind: 'success' as const, geometry })
            })
          )
        )
      ).pipe(
        Effect.provide(CollisionGeometryBuilder.Live),
        Effect.provide(Layer.succeed(GeometrySettings, geometrySettings))
      )
    )
    expect(stressOutcomes.map((outcome) => outcome.kind)).toEqual([
      'failure',
      'success',
      'failure',
      'success',
      'success'
    ])
    const successfulStressOutcome = stressOutcomes[1]
    if (successfulStressOutcome?.kind !== 'success') {
      throw new Error('expected tiny-segment fixture to build collision geometry')
    }
    expect(
      successfulStressOutcome.geometry.sampledPoints.every(
        (point) => Number.isFinite(point.x) && Number.isFinite(point.y)
      )
    ).toBe(true)
    expect(
      Number.isFinite(
        collisionOpportunityMetrics(successfulStressOutcome.geometry).collisionPolygonAreaMm2
      )
    ).toBe(true)

    const invalidSource = await importFixture('unsupported-entities.dxf')
    expect(
      invalidSource.warnings.some(
        (warning: ImportWarning) => warning.code === 'partially_unsupported_outline'
      )
    ).toBe(true)
    const failure = await Effect.runPromise(
      CollisionGeometryBuilder.use((builder) =>
        builder.buildPiece({ piece: invalidSource, totalPaddingMm: 0 })
      ).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => undefined
        }),
        Effect.provide(CollisionGeometryBuilder.Live),
        Effect.provide(Layer.succeed(GeometrySettings, geometrySettings))
      )
    )
    expect(failure).toBeInstanceOf(IrregularGeometryInputError)
  })
})
