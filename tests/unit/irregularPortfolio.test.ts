import { Effect, Layer, Schema } from 'effect'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { importDxfFile } from '@main/services/DxfImportService.js'
import { JobId } from '@shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '@shared/domain/nesting.js'
import { preparePieces } from '@shared/preparePieces.js'
import {
  IrregularNestingSettings,
  IrregularOptimizerSettings,
  IrregularPortfolioProgress,
  IrregularPortfolioResult
} from '@shared/irregular/domain.js'
import {
  computeIrregularNesting,
  type ComputeIrregularNestingOptions,
  type IrregularComputeResult
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { IrregularLayoutScorer } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../../src/workers/irregular/freeMaterialService.js'
import { GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const fixturesDir = join(repoRoot, 'tests', 'fixtures', 'dxf')

const sourcesPromise = Promise.all(
  ['triangle.dxf', 'trapezoid.dxf'].map(async (fixture) => {
    const document = await importDxfFile(join(fixturesDir, fixture))
    const piece = document.pieces[0]
    if (piece === undefined) throw new Error(`fixture ${fixture} imported without a piece`)
    return piece
  })
)

function settings(
  overrides: Partial<ConstructorParameters<typeof IrregularOptimizerSettings>[0]> = {}
) {
  return Schema.decodeUnknownSync(IrregularNestingSettings)({
    geometry: {
      flatteningSagToleranceMm: 0.25,
      clearanceSafetyMarginMm: 0.25,
      geometryBackendId: 'portfolio-test',
      geometryBackendVersion: '1'
    },
    optimizer: {
      orderWindow: 1,
      beamWidth: 4,
      transformCap: 4,
      transformMinimumEdgeLengthMm: 0,
      transformAngleDeduplicationToleranceDeg: 0.01,
      configuredRotationDeg: [],
      gaPopulation: 4,
      gaTimeBudgetMs: 60_000,
      gaSeed: 'portfolio-reproducibility-seed',
      gaEnabled: true,
      gaEvaluationBudget: 8,
      placementPolicyId: 'balanced-compactness',
      placementPolicyIds: ['balanced-compactness', 'short-side-fill'],
      ...overrides
    }
  })
}

function request(sources: Awaited<typeof sourcesPromise>): NestingRequest {
  const sheet = new SheetSpec({ width: 260, height: 100, label: 'portfolio test sheet' })
  const prepared = preparePieces(sources, sheet, 0, JobId.make('portfolio-test-job')).pieces
  return new NestingRequest({
    version: 1,
    jobId: JobId.make('portfolio-test-job'),
    sheet,
    padding: 0,
    pieces: prepared,
    sourcePieces: sources,
    options: new NestingOptions({
      allowGlobalRotation: true,
      timeoutMs: 60_000,
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

function run(
  nestingRequest: NestingRequest,
  geometrySettings: IrregularNestingSettings,
  options: ComputeIrregularNestingOptions = {}
) {
  return computeIrregularNesting(nestingRequest, options).pipe(
    Effect.provide(CollisionGeometryBuilder.Live),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(NfpIfpServiceLive),
    Effect.provide(FreeMaterialServiceLive),
    Effect.provide(IrregularPlacementScorer.Live),
    Effect.provide(IrregularLayoutScorer.Live),
    Effect.provide(Layer.succeed(GeometrySettings, geometrySettings))
  )
}

function deterministicProgress(progress: IrregularPortfolioProgress) {
  return {
    phase: progress.phase,
    generation: progress.generation,
    evaluationsCompleted: progress.evaluationsCompleted,
    populationSize: progress.populationSize,
    bestScore: progress.bestScore,
    bestSource: progress.bestSource
  }
}

function publicPortfolio(result: IrregularComputeResult): IrregularPortfolioResult {
  return result.portfolio
}

describe('irregular GA portfolio', () => {
  it('reproduces the validated result and deterministic progress sequence for a seed', async () => {
    const sources = await sourcesPromise
    const nestingRequest = request(sources)
    const geometrySettings = settings()
    const firstProgress: IrregularPortfolioProgress[] = []
    const secondProgress: IrregularPortfolioProgress[] = []

    const first = await Effect.runPromise(
      run(nestingRequest, geometrySettings, {
        emitPortfolioProgress: (progress) => {
          firstProgress.push(progress)
          return Effect.void
        }
      })
    )
    const second = await Effect.runPromise(
      run(nestingRequest, geometrySettings, {
        emitPortfolioProgress: (progress) => {
          secondProgress.push(progress)
          return Effect.void
        }
      })
    )

    expect(publicPortfolio(first)).toEqual(publicPortfolio(second))
    expect(firstProgress.map(deterministicProgress)).toEqual(
      secondProgress.map(deterministicProgress)
    )
    expect(firstProgress.map(({ phase }) => phase)).toEqual([
      'deterministic_beam',
      ...Array.from({ length: 8 }, () => 'ga_search'),
      'validating'
    ])
    expect(firstProgress.at(-1)?.evaluationsCompleted).toBe(8)

    const outputKeys = Object.keys(
      JSON.parse(
        JSON.stringify({
          portfolio: publicPortfolio(first),
          progress: firstProgress
        })
      )
    )
    expect(outputKeys).not.toContain('chromosome')
    expect(
      JSON.stringify({ portfolio: publicPortfolio(first), progress: firstProgress })
    ).not.toMatch(/priorityOrder|transformPreferences/)
  })

  it('returns an honest cancelled result when cancellation is already requested', async () => {
    const sources = await sourcesPromise
    const result = await Effect.runPromise(
      run(request(sources), settings(), { isCancelled: () => true })
    )

    expect(result.portfolio.status).toBe('cancelled')
    expect(result.portfolio.source).toBe('none')
    expect(result.portfolio.placements).toEqual([])
    expect(result.portfolio.unplacedPieceIds).toEqual(sources.map(({ id }) => id).sort())
  })

  it('expires at the evaluation checkpoint and completes when zero time disables GA', async () => {
    const sources = await sourcesPromise
    const budgetProgress: IrregularPortfolioProgress[] = []
    const budgetResult = await Effect.runPromise(
      run(request(sources), settings({ gaEvaluationBudget: 1 }), {
        emitPortfolioProgress: (progress) => {
          budgetProgress.push(progress)
          return Effect.void
        }
      })
    )

    expect(budgetResult.portfolio.status).toBe('budget-expired')
    expect(
      budgetResult.portfolio.placements.length + budgetResult.portfolio.unplacedPieceIds.length
    ).toBe(sources.length)
    expect(budgetProgress.at(-1)?.phase).toBe('validating')
    expect(budgetProgress.at(-1)?.evaluationsCompleted).toBe(1)

    const completedProgress: IrregularPortfolioProgress[] = []
    const completedResult = await Effect.runPromise(
      run(request(sources), settings({ gaTimeBudgetMs: 0 }), {
        emitPortfolioProgress: (progress) => {
          completedProgress.push(progress)
          return Effect.void
        }
      })
    )

    expect(completedResult.portfolio.status).toBe('completed')
    expect(completedResult.portfolio.source).toBe('beam')
    expect(completedProgress.map(({ phase }) => phase)).toEqual(['deterministic_beam'])
  })
})
