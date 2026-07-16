import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importDxfFile } from '@main/services/DxfImportService.js'
import { ImportedPiece, ImportWarning } from '@shared/domain/dxf.js'
import { NestingOptions, NestingRequest, SheetSpec } from '@shared/domain/nesting.js'
import { JobId } from '@shared/domain/ids.js'
import {
  IrregularNestingSettings,
  IrregularOptimizerSettings,
  IrregularPoint
} from '@shared/irregular/domain.js'
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
import {
  IrregularLayoutScorer,
  type IrregularLayoutScore
} from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { IrregularGeometryInputError } from '../../src/workers/irregular/services.js'
import { DEFAULT_STRATEGY_ID } from '@shared/domain/strategies.js'
import {
  IRREGULAR_BENCHMARK_RUNNER_VERSION,
  makeBenchmarkProvenance,
  normalizeImportedPieceIdentities,
  resolveBenchmarkOptions,
  runNamedBenchmarkProfile,
  summarizeBenchmarkScore,
  summarizeResolvedBenchmarkSettings
} from '../../scripts/irregular-benchmark.js'
import {
  calculateAreaFeasibilityBounds,
  collisionOpportunityMetrics,
  DETERMINISTIC_GA_TIME_BUDGET_MS,
  IRREGULAR_BENCHMARK_CORPUS,
  IRREGULAR_BENCHMARK_PROFILES,
  polygonArea,
  polygonBoundingBoxArea,
  repeatImportedPieces
} from '../fixtures/irregularBenchmarkFixtures.js'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const fixturesDir = join(repoRoot, 'tests', 'fixtures', 'dxf')

function reachableCommitSha(ref: string): string | undefined {
  try {
    const output = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const sha = output.trim()
    return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

function withBenchmarkRevisionEnvironment<T>(
  baselineSha: string | undefined,
  variantSha: string | undefined,
  callback: () => T
): T {
  const previousBaselineSha = process.env.IRREGULAR_BENCHMARK_BASELINE_SHA
  const previousVariantSha = process.env.IRREGULAR_BENCHMARK_VARIANT_SHA
  if (baselineSha === undefined) {
    delete process.env.IRREGULAR_BENCHMARK_BASELINE_SHA
  } else {
    process.env.IRREGULAR_BENCHMARK_BASELINE_SHA = baselineSha
  }
  if (variantSha === undefined) {
    delete process.env.IRREGULAR_BENCHMARK_VARIANT_SHA
  } else {
    process.env.IRREGULAR_BENCHMARK_VARIANT_SHA = variantSha
  }

  try {
    return callback()
  } finally {
    if (previousBaselineSha === undefined) {
      delete process.env.IRREGULAR_BENCHMARK_BASELINE_SHA
    } else {
      process.env.IRREGULAR_BENCHMARK_BASELINE_SHA = previousBaselineSha
    }
    if (previousVariantSha === undefined) {
      delete process.env.IRREGULAR_BENCHMARK_VARIANT_SHA
    } else {
      process.env.IRREGULAR_BENCHMARK_VARIANT_SHA = previousVariantSha
    }
  }
}

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

async function compareScores(
  first: IrregularLayoutScore,
  second: IrregularLayoutScore
): Promise<number> {
  const scorer = await Effect.runPromise(
    IrregularLayoutScorer.use((service) => Effect.succeed(service)).pipe(
      Effect.provide(IrregularLayoutScorer.Live),
      Effect.provide(GeometrySettings.Live)
    )
  )
  return scorer.compare(first, second)
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

type NamedProfileExecution = Awaited<ReturnType<typeof runNamedBenchmarkProfile>>

function executionRun(
  execution: NamedProfileExecution
): NamedProfileExecution['measuredRuns'][number] {
  const run = execution.measuredRuns[0]
  if (run === undefined) throw new Error('expected one measured benchmark run')
  return run
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

    expect(summarizeBenchmarkScore(first.score)).toEqual({
      unplacedCount: first.score.unplacedCount,
      largestNetFreeMaterialRegionAreaMm2: first.score.largestNetFreeMaterialRegionAreaMm2,
      freeMaterialRegionCount: first.score.freeMaterialRegionCount,
      freeMaterialHoleCount: first.score.freeMaterialHoleCount,
      freeMaterialSliverMetric: first.score.freeMaterialSliverMetric,
      collisionBoundsWorstNormalizedSheetConsumption:
        first.score.collisionBoundsWorstNormalizedSheetConsumption,
      collisionBoundsNormalizedSpanSum: first.score.collisionBoundsNormalizedSpanSum,
      collisionBoundsAreaMm2: first.score.collisionBoundsAreaMm2,
      collisionBoundsSpanMm: first.score.collisionBoundsSpanMm,
      placementOrder: [...first.score.placementOrder],
      unplacedSourcePieceIds: [...first.score.unplacedSourcePieceIds]
    })

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

  it('keeps corpus cases deterministic and within their source budgets', () => {
    expect(IRREGULAR_BENCHMARK_CORPUS).toHaveLength(3)
    for (const benchmarkCase of IRREGULAR_BENCHMARK_CORPUS) {
      expect(benchmarkCase.fixtureNames.length).toBeGreaterThan(0)
      expect(benchmarkCase.pieceCount).toBeLessThanOrEqual(
        benchmarkCase.fixtureNames.length * benchmarkCase.repeatCount
      )
      expect(benchmarkCase.sheetWidth).toBeGreaterThan(0)
      expect(benchmarkCase.sheetHeight).toBeGreaterThan(0)
    }
  })

  it('calculates deterministic raw-area feasibility bounds for every corpus case', () => {
    const firstBounds = IRREGULAR_BENCHMARK_CORPUS.map(calculateAreaFeasibilityBounds)
    const secondBounds = IRREGULAR_BENCHMARK_CORPUS.map(calculateAreaFeasibilityBounds)
    expect(secondBounds).toEqual(firstBounds)

    const skewedQuadCase = IRREGULAR_BENCHMARK_CORPUS.find(
      ({ id }) => id === 'skewed-quad-12-330x160'
    )
    if (skewedQuadCase === undefined) throw new Error('expected skewed quad corpus case')
    expect(calculateAreaFeasibilityBounds(skewedQuadCase)).toEqual({
      rawPieceAreaLowerBoundMm2: 38_400,
      axisAlignedBoundingBoxAreaMm2: 52_800,
      sheetAreaMm2: 52_800,
      rawAreaSlackMm2: 14_400,
      axisAlignedBoundingBoxAreaSlackMm2: 0,
      rawAreaNecessaryConditionPasses: true
    })
  })

  it('validates declared corpus areas and bounds against checked-in DXF geometry', async () => {
    for (const benchmarkCase of IRREGULAR_BENCHMARK_CORPUS) {
      const pieces = await Promise.all(benchmarkCase.fixtureNames.map(importFixture))
      expect(pieces).toHaveLength(benchmarkCase.fixtureNames.length)
      expect(benchmarkCase.fixtureAreasMm2).toHaveLength(benchmarkCase.fixtureNames.length)
      expect(benchmarkCase.fixtureBoundingBoxAreasMm2).toHaveLength(
        benchmarkCase.fixtureNames.length
      )

      for (const [fixtureIndex, piece] of pieces.entries()) {
        const declaredArea = benchmarkCase.fixtureAreasMm2[fixtureIndex]
        const declaredBoundingBoxArea = benchmarkCase.fixtureBoundingBoxAreasMm2[fixtureIndex]
        if (declaredArea === undefined || declaredBoundingBoxArea === undefined) {
          throw new Error(`expected area metadata for ${benchmarkCase.id}`)
        }

        const points: IrregularPoint[] = []
        for (const segment of piece.geometry.segments) {
          if (segment.kind !== 'line') {
            throw new Error(`expected straight benchmark geometry for ${benchmarkCase.id}`)
          }
          points.push(new IrregularPoint({ x: segment.x1, y: segment.y1 }))
        }

        expect(polygonArea(points)).toBeCloseTo(declaredArea, 8)
        expect(polygonBoundingBoxArea(points)).toBeCloseTo(declaredBoundingBoxArea, 8)
      }
    }
  })

  it('reports replay provenance and resolved named-profile settings', () => {
    const variantSha = reachableCommitSha('HEAD')
    if (variantSha === undefined) throw new Error('expected HEAD to resolve to a commit SHA')
    const baselineSha = reachableCommitSha('origin/main') ?? variantSha
    const argumentsList = [
      '--profile',
      'near-capacity-skewed-beam-4',
      '--baseline-sha',
      baselineSha,
      '--variant-sha',
      variantSha
    ]
    const provenance = makeBenchmarkProvenance(argumentsList, repoRoot, {
      nodeVersion: 'v-test',
      pnpmVersion: '10.0.0',
      platform: 'test-platform',
      architecture: 'test-architecture',
      hostIdentifier: 'test-host',
      timestamp: '2026-07-16T00:00:00.000Z'
    })
    expect(provenance).toEqual({
      baselineSha,
      variantSha,
      baselineRevision: {
        sha: baselineSha,
        requested: baselineSha,
        ref: null,
        source: 'cli',
        environmentVariable: 'IRREGULAR_BENCHMARK_BASELINE_SHA'
      },
      variantRevision: {
        sha: variantSha,
        requested: variantSha,
        ref: null,
        source: 'cli',
        environmentVariable: 'IRREGULAR_BENCHMARK_VARIANT_SHA'
      },
      nodeVersion: 'v-test',
      pnpmVersion: '10.0.0',
      platform: 'test-platform',
      architecture: 'test-architecture',
      hostIdentifier: 'test-host',
      timestamp: '2026-07-16T00:00:00.000Z',
      exactCommand:
        `pnpm benchmark:irregular --profile near-capacity-skewed-beam-4 --baseline-sha ${baselineSha} --variant-sha ${variantSha}`,
      runnerVersion: IRREGULAR_BENCHMARK_RUNNER_VERSION
    })

    expect(() => makeBenchmarkProvenance(['--baseline-sha', 'baseline-sha'], repoRoot)).toThrow(
      'expects a full 40-character commit SHA'
    )

    const unavailableExplicitProvenance = makeBenchmarkProvenance(
      ['--baseline-sha', '0'.repeat(40), '--variant-sha', variantSha],
      repoRoot
    )
    expect(unavailableExplicitProvenance.baselineRevision).toEqual({
      sha: null,
      requested: '0'.repeat(40),
      ref: null,
      source: 'unavailable',
      environmentVariable: 'IRREGULAR_BENCHMARK_BASELINE_SHA'
    })
    expect(unavailableExplicitProvenance.variantRevision.sha).toBe(variantSha)
    expect(unavailableExplicitProvenance.exactCommand).toBeNull()

    const environmentBaselineSha = baselineSha
    const environmentVariantSha = variantSha
    const environmentProvenance = withBenchmarkRevisionEnvironment(
      environmentBaselineSha,
      environmentVariantSha,
      () => makeBenchmarkProvenance([], repoRoot)
    )
    expect(environmentProvenance.baselineRevision).toEqual({
      sha: environmentBaselineSha,
      requested: environmentBaselineSha,
      ref: null,
      source: 'environment',
      environmentVariable: 'IRREGULAR_BENCHMARK_BASELINE_SHA'
    })
    expect(environmentProvenance.variantRevision).toEqual({
      sha: environmentVariantSha,
      requested: environmentVariantSha,
      ref: null,
      source: 'environment',
      environmentVariable: 'IRREGULAR_BENCHMARK_VARIANT_SHA'
    })

    const defaultProvenance = withBenchmarkRevisionEnvironment(undefined, undefined, () =>
      makeBenchmarkProvenance([], repoRoot, {
        nodeVersion: 'v-test',
        pnpmVersion: '10.0.0',
        platform: 'test-platform',
        architecture: 'test-architecture',
        hostIdentifier: 'test-host',
        timestamp: '2026-07-16T00:00:00.000Z'
      })
    )
    const expectedDefaultBaselineSha = reachableCommitSha('origin/main')
    const expectedDefaultVariantSha = reachableCommitSha('HEAD')
    expect(defaultProvenance.baselineRevision).toEqual({
      sha: expectedDefaultBaselineSha,
      requested: 'origin/main',
      ref: 'origin/main',
      source: expectedDefaultBaselineSha === undefined ? 'unavailable' : 'default-ref',
      environmentVariable: 'IRREGULAR_BENCHMARK_BASELINE_SHA'
    })
    expect(defaultProvenance.variantRevision).toEqual({
      sha: expectedDefaultVariantSha,
      requested: 'HEAD',
      ref: 'HEAD',
      source: expectedDefaultVariantSha === undefined ? 'unavailable' : 'default-ref',
      environmentVariable: 'IRREGULAR_BENCHMARK_VARIANT_SHA'
    })
    expect(defaultProvenance.baselineRevision.ref).toBe('origin/main')
    expect(defaultProvenance.variantRevision.ref).toBe('HEAD')
    const defaultBaselineSha = defaultProvenance.baselineSha
    const defaultVariantSha = defaultProvenance.variantSha
    const defaultExactCommand = defaultProvenance.exactCommand
    expect(defaultBaselineSha).toBe(expectedDefaultBaselineSha ?? null)
    expect(defaultVariantSha).toBe(expectedDefaultVariantSha ?? null)
    if (expectedDefaultBaselineSha === undefined || expectedDefaultVariantSha === undefined) {
      expect(defaultExactCommand).toBeNull()
    } else {
      if (defaultExactCommand === null) {
        throw new Error('expected reachable default revisions to produce an exact command')
      }
      expect(defaultExactCommand).toBe(
        `pnpm benchmark:irregular --baseline-sha ${expectedDefaultBaselineSha} --variant-sha ${expectedDefaultVariantSha}`
      )
    }

    const unavailableProvenance = withBenchmarkRevisionEnvironment(undefined, undefined, () =>
      makeBenchmarkProvenance([], join(repoRoot, 'missing-benchmark-repository'))
    )
    expect(unavailableProvenance.baselineRevision).toEqual({
      sha: null,
      requested: 'origin/main',
      ref: 'origin/main',
      source: 'unavailable',
      environmentVariable: 'IRREGULAR_BENCHMARK_BASELINE_SHA'
    })
    expect(unavailableProvenance.variantRevision).toEqual({
      sha: null,
      requested: 'HEAD',
      ref: 'HEAD',
      source: 'unavailable',
      environmentVariable: 'IRREGULAR_BENCHMARK_VARIANT_SHA'
    })
    expect(unavailableProvenance.exactCommand).toBeNull()

    const firstSettings = summarizeResolvedBenchmarkSettings(
      resolveBenchmarkOptions(['--profile', 'near-capacity-skewed-beam-4'])
    )
    const secondSettings = summarizeResolvedBenchmarkSettings(
      resolveBenchmarkOptions(['--profile', 'near-capacity-skewed-beam-4'])
    )
    expect(secondSettings).toEqual(firstSettings)
    expect(firstSettings).toMatchObject({
      profileId: 'near-capacity-skewed-beam-4',
      fixtureNames: ['benchmark-skewed-quad.dxf'],
      pieceCount: 12,
      repeatCount: 12,
      sheetWidth: 330,
      sheetHeight: 160,
      beamWidth: 4,
      corpusCaseId: 'skewed-quad-12-330x160',
      areaFeasibilityBounds: {
        rawPieceAreaLowerBoundMm2: 38_400,
        axisAlignedBoundingBoxAreaMm2: 52_800,
        sheetAreaMm2: 52_800,
        rawAreaSlackMm2: 14_400,
        axisAlignedBoundingBoxAreaSlackMm2: 0,
        rawAreaNecessaryConditionPasses: true
      },
      profileDescription: 'Wider same-count profile for comparing raw skewed-quad layout usability.'
    })

    const overriddenSettings = summarizeResolvedBenchmarkSettings(
      resolveBenchmarkOptions(['--profile', 'near-capacity-skewed-beam-4', '--sheet', '330x161'])
    )
    expect(overriddenSettings.corpusCaseId).toBeUndefined()
    expect(overriddenSettings.areaFeasibilityBounds).toBeUndefined()
  })

  it('gives explicit GA and baseline flags precedence over profile defaults', () => {
    const enabledFromBeamProfile = resolveBenchmarkOptions([
      '--profile',
      'near-capacity-beam-1',
      '--ga-enabled=true'
    ])
    expect(enabledFromBeamProfile.gaEnabled).toBe(true)
    expect(enabledFromBeamProfile.baselineOnly).toBe(false)

    const disabledFromGaProfile = resolveBenchmarkOptions([
      '--profile',
      'near-capacity-ga',
      '--ga-enabled=false'
    ])
    expect(disabledFromGaProfile.gaEnabled).toBe(false)
    expect(disabledFromGaProfile.baselineOnly).toBe(true)

    const explicitBaselineOverride = resolveBenchmarkOptions([
      '--profile',
      'near-capacity-ga',
      '--ga-enabled=false',
      '--baseline-only=false'
    ])
    expect(explicitBaselineOverride.gaEnabled).toBe(false)
    expect(explicitBaselineOverride.baselineOnly).toBe(false)

    const baselineOverrideFromBeamProfile = resolveBenchmarkOptions([
      '--profile',
      'near-capacity-beam-1',
      '--baseline-only=false'
    ])
    expect(baselineOverrideFromBeamProfile.gaEnabled).toBe(false)
    expect(baselineOverrideFromBeamProfile.baselineOnly).toBe(false)

    expect(() =>
      resolveBenchmarkOptions(['--profile', 'near-capacity-ga', '--baseline-only=true'])
    ).toThrow('GA is enabled but --baseline-only is true')

    expect(() =>
      resolveBenchmarkOptions([
        '--profile',
        'near-capacity-beam-1',
        '--ga-enabled=true',
        '--baseline-only=true'
      ])
    ).toThrow('GA is enabled but --baseline-only is true')
  })

  it('executes named capacity profiles through the shared runner path', async () => {
    const beamExecution = await runNamedBenchmarkProfile('near-capacity-beam-1')
    const gaLiteExecution = await runNamedBenchmarkProfile('near-capacity-ga-lite')
    const gaExecution = await runNamedBenchmarkProfile('near-capacity-ga')
    const wideExecution = await runNamedBenchmarkProfile('near-capacity-wide-beam-4')
    const executions = [beamExecution, gaLiteExecution, gaExecution, wideExecution]

    for (const execution of executions) {
      const profile = IRREGULAR_BENCHMARK_PROFILES.find(({ id }) => id === execution.profileId)
      if (profile === undefined) throw new Error('expected a named benchmark profile')
      const corpusCase = IRREGULAR_BENCHMARK_CORPUS.find(({ id }) => id === profile.corpusCaseId)
      if (corpusCase === undefined) throw new Error('expected a profile corpus case')

      expect(execution.fixtureNames).toEqual(corpusCase.fixtureNames)
      expect(execution.repeatCount).toBe(corpusCase.repeatCount)
      expect(execution.pieceCount).toBe(corpusCase.pieceCount)
      expect(execution.sheetWidth).toBe(corpusCase.sheetWidth)
      expect(execution.sheetHeight).toBe(corpusCase.sheetHeight)
      expect(execution.sourceCount).toBe(execution.pieceCount)
      expect(execution.pieceCount).toBeLessThanOrEqual(
        execution.fixtureNames.length * execution.repeatCount
      )
      expect(execution.measuredRuns).toHaveLength(1)
      expect(execution.measuredRuns[0]?.auditStatus).toBe('passed')
    }

    const beamRun = executionRun(beamExecution)
    const gaLiteRun = executionRun(gaLiteExecution)
    const gaRun = executionRun(gaExecution)
    const wideRun = executionRun(wideExecution)

    expect(gaRun.placedCount).toBe(20)
    expect(gaRun.unplacedCount).toBe(0)
    expect(wideRun.placedCount).toBe(20)
    expect(wideRun.unplacedCount).toBe(0)
    expect(beamRun.unplacedCount).toBe(gaLiteRun.unplacedCount)
    expect(await compareScores(gaLiteRun.score, beamRun.score)).toBeLessThan(0)
    expect(gaLiteRun.portfolioTerminationReason).toBe('generation_budget')

    const repeatedGaLiteExecution = await runNamedBenchmarkProfile('near-capacity-ga-lite')
    const repeatedGaLiteRun = executionRun(repeatedGaLiteExecution)
    expect(summarizeBenchmarkScore(repeatedGaLiteRun.score)).toEqual(
      summarizeBenchmarkScore(gaLiteRun.score)
    )
    expect(repeatedGaLiteRun.portfolioSource).toBe(gaLiteRun.portfolioSource)
    expect(repeatedGaLiteRun.portfolioStatus).toBe(gaLiteRun.portfolioStatus)
    expect(repeatedGaLiteRun.portfolioTerminationReason).toBe(
      gaLiteRun.portfolioTerminationReason
    )

    expect(
      IRREGULAR_BENCHMARK_PROFILES
        .filter(({ gaEnabled }) => gaEnabled)
        .every(({ gaTimeBudgetMs }) => gaTimeBudgetMs === DETERMINISTIC_GA_TIME_BUDGET_MS)
    ).toBe(true)
  }, 60_000)

  it('executes skewed profiles and proves a strict same-count usability ordering', async () => {
    const narrowExecution = await runNamedBenchmarkProfile('near-capacity-skewed-beam-1')
    const wideExecution = await runNamedBenchmarkProfile('near-capacity-skewed-beam-4')
    const narrowRun = executionRun(narrowExecution)
    const wideRun = executionRun(wideExecution)

    expect(narrowExecution.sourceCount).toBe(12)
    expect(wideExecution.sourceCount).toBe(12)
    expect(narrowRun.auditStatus).toBe('passed')
    expect(wideRun.auditStatus).toBe('passed')
    expect(narrowRun.unplacedCount).toBe(wideRun.unplacedCount)

    const usabilityDiffers = [
      narrowRun.score.largestNetFreeMaterialRegionAreaMm2 !==
        wideRun.score.largestNetFreeMaterialRegionAreaMm2,
      narrowRun.score.freeMaterialRegionCount !== wideRun.score.freeMaterialRegionCount,
      narrowRun.score.freeMaterialHoleCount !== wideRun.score.freeMaterialHoleCount,
      narrowRun.score.freeMaterialSliverMetric !== wideRun.score.freeMaterialSliverMetric,
      narrowRun.score.collisionBoundsWorstNormalizedSheetConsumption !==
        wideRun.score.collisionBoundsWorstNormalizedSheetConsumption,
      narrowRun.score.collisionBoundsNormalizedSpanSum !==
        wideRun.score.collisionBoundsNormalizedSpanSum,
      narrowRun.score.collisionBoundsAreaMm2 !== wideRun.score.collisionBoundsAreaMm2,
      narrowRun.score.collisionBoundsSpanMm !== wideRun.score.collisionBoundsSpanMm
    ].some(Boolean)
    expect(usabilityDiffers).toBe(true)
    expect(await compareScores(wideRun.score, narrowRun.score)).toBeLessThan(0)

    const repeatedWideExecution = await runNamedBenchmarkProfile('near-capacity-skewed-beam-4')
    expect(summarizeBenchmarkScore(executionRun(repeatedWideExecution).score)).toEqual(
      summarizeBenchmarkScore(wideRun.score)
    )
  }, 60_000)

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
