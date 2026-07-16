import { Effect, Layer, Schema } from 'effect'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { importDxfFile } from '@main/services/DxfImportService.js'
import { JobId, PieceId } from '@shared/domain/ids.js'
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
  type IrregularFinalizationMetrics,
  type IrregularComputeResult
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { IrregularLayoutScorer } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import {
  makeDeterministicInitialPopulation,
  selectBetterIrregularPortfolioCandidate,
  type IrregularChromosomeGeneControls,
  type IrregularChromosomePiece,
  type IrregularPortfolioChromosome,
  type IrregularPortfolioPhaseMeasurement,
  type IrregularPortfolioMetrics
} from '../../src/workers/algorithm/irregular/portfolioSearch.js'
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
      baselineOnly: false,
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

function request(
  sources: Awaited<typeof sourcesPromise>,
  historyMode: NestingOptions['historyMode'] = 'off'
): NestingRequest {
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
      historyMode,
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

function makeLayoutScorer(
  geometrySettings: IrregularNestingSettings
): Promise<IrregularLayoutScorer.Service> {
  return Effect.runPromise(
    IrregularLayoutScorer.use((service) => Effect.succeed(service)).pipe(
      Effect.provide(IrregularLayoutScorer.Live),
      Effect.provide(Layer.succeed(GeometrySettings, geometrySettings))
    )
  )
}

function chromosomeKey(chromosome: IrregularPortfolioChromosome): string {
  const transforms = [...chromosome.transformPreferences.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([pieceId, transformIndex]) => `${pieceId}:${transformIndex}`)
    .join(',')
  return `${chromosome.priorityOrder.join('|')}::${transforms}::${chromosome.policyId}`
}

describe('irregular GA portfolio', () => {
  it('creates deterministic diverse initial chromosomes around the baseline', () => {
    const firstPieceId = PieceId.make('seed-piece-a')
    const secondPieceId = PieceId.make('seed-piece-b')
    const pieces: ReadonlyArray<IrregularChromosomePiece> = [
      {
        pieceId: firstPieceId,
        source: { id: firstPieceId },
        transforms: [{ index: 0 }, { index: 1 }, { index: 2 }]
      },
      {
        pieceId: secondPieceId,
        source: { id: secondPieceId },
        transforms: [{ index: 0 }, { index: 1 }, { index: 2 }]
      }
    ]
    const baseline: IrregularPortfolioChromosome = {
      priorityOrder: [firstPieceId, secondPieceId],
      transformPreferences: new Map(),
      policyId: 'balanced-compactness'
    }
    const geneControls: IrregularChromosomeGeneControls = {
      priorityOrderMutationEnabled: true,
      transformPreferenceMutationEnabled: true,
      placementPolicyMutationEnabled: true
    }
    const input = {
      baseline,
      pieces,
      configuredPolicies: ['balanced-compactness', 'short-side-fill'] as const,
      populationSize: 8,
      gaSeed: 'diversity-regression-seed',
      geneControls
    }

    const first = makeDeterministicInitialPopulation(input)
    const second = makeDeterministicInitialPopulation(input)

    expect(first[0]).toBe(baseline)
    expect(first.map(chromosomeKey)).toEqual(second.map(chromosomeKey))
    expect(new Set(first.map(chromosomeKey)).size).toBeGreaterThanOrEqual(4)
  })

  it('never lets GA selection regress the deterministic baseline score', async () => {
    const sources = await sourcesPromise
    const baseline = await Effect.runPromise(
      run(
        request(sources),
        settings({
          gaEnabled: false,
          baselineOnly: true,
          gaEvaluationBudget: 0,
          gaGenerationBudget: 0,
          gaTimeBudgetMs: 0
        })
      )
    )
    const ga = await Effect.runPromise(
      run(
        request(sources),
        settings({
          gaEnabled: true,
          baselineOnly: false,
          gaPopulation: 6,
          gaGenerationBudget: 1,
          gaEvaluationBudget: 6,
          gaTimeBudgetMs: 60_000,
          gaSeed: 'incumbent-regression-seed'
        })
      )
    )

    const scorer = await makeLayoutScorer(settings())
    const comparison = scorer.compare(ga.score, baseline.score)
    expect(comparison).toBeLessThanOrEqual(0)
    if (comparison === 0) {
      expect(ga.portfolio.placements).toEqual(baseline.portfolio.placements)
    }
    expect(ga.portfolio.unplacedPieceIds.length).toBeLessThanOrEqual(
      baseline.portfolio.unplacedPieceIds.length
    )
  })

  it('reports bounded deterministic GA decoder metrics', async () => {
    const sources = await sourcesPromise
    const portfolioMetrics: IrregularPortfolioMetrics[] = []
    const phaseMeasurements: IrregularPortfolioPhaseMeasurement[] = []
    const finalizationMetrics: IrregularFinalizationMetrics[] = []
    const result = await Effect.runPromise(
      run(
        request(sources),
        settings({
          gaEnabled: true,
          baselineOnly: false,
          gaPopulation: 2,
          gaGenerationBudget: 1,
          gaEvaluationBudget: 2,
          gaTimeBudgetMs: 60_000,
          gaSeed: 'portfolio-metrics-regression-seed'
        }),
        {
          onPortfolioMetrics: (metrics) => {
            portfolioMetrics.push(metrics)
          },
          onPortfolioPhase: (measurement) => {
            phaseMeasurements.push(measurement)
          },
          onFinalizationMetrics: (metrics) => {
            finalizationMetrics.push(metrics)
          }
        }
      )
    )
    const metrics = portfolioMetrics[0]
    const finalization = finalizationMetrics[0]
    if (metrics === undefined || finalization === undefined) {
      throw new Error('expected benchmark-only instrumentation to report one completed run')
    }

    expect(result.portfolio.terminationReason).toBe('generation_budget')
    expect(phaseMeasurements.map(({ phase }) => phase)).toEqual([
      'baseline-decode',
      'ga-decode'
    ])
    expect(metrics.scheduledEvaluationSlots).toBe(2)
    expect(metrics.distinctChromosomeKeys).toBe(2)
    expect(metrics.evaluatedChromosomeCacheHits).toBe(1)
    expect(metrics.evaluatedChromosomeCacheMisses).toBe(1)
    expect(metrics.actualFullBeamDecodes).toBe(2)
    expect(
      metrics.evaluatedChromosomeCacheHits + metrics.evaluatedChromosomeCacheMisses
    ).toBe(metrics.scheduledEvaluationSlots)
    expect(metrics.decodedBeamCandidateCount).toBe(
      phaseMeasurements.reduce(
        (candidateTotal, measurement) => candidateTotal + measurement.candidateCount,
        0
      )
    )
    expect(metrics.decodedBeamElapsedMs).toBe(
      phaseMeasurements.reduce(
        (elapsedTotal, measurement) => elapsedTotal + measurement.elapsedMs,
        0
      )
    )
    expect(finalization.reconstructionElapsedMs).toBeGreaterThanOrEqual(0)
    expect(finalization.finalScoreElapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('keeps instrumented GA deadline termination identical to the uninstrumented run', async () => {
    const sources = await sourcesPromise
    const geometrySettings = settings({
      gaEnabled: true,
      baselineOnly: false,
      gaPopulation: 2,
      gaGenerationBudget: 2,
      gaEvaluationBudget: 4,
      gaTimeBudgetMs: 10,
      gaSeed: 'deadline-instrumentation-parity-seed'
    })
    let nowMs = 0
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)

    try {
      const uninstrumented = await Effect.runPromise(run(request(sources), geometrySettings))
      const portfolioMetrics: IrregularPortfolioMetrics[] = []
      const instrumented = await Effect.runPromise(
        run(request(sources), geometrySettings, {
          onPortfolioMetrics: (metrics) => {
            portfolioMetrics.push(metrics)
          },
          onPortfolioPhase: (measurement) => {
            if (measurement.phase === 'ga-decode') nowMs += 20
          }
        })
      )

      expect(portfolioMetrics).toHaveLength(1)
      expect(instrumented.portfolio.terminationReason).toBe('generation_budget')
      expect(instrumented.portfolio.terminationReason).toBe(
        uninstrumented.portfolio.terminationReason
      )
      expect(publicPortfolio(instrumented)).toEqual(publicPortfolio(uninstrumented))
      expect(instrumented.score).toEqual(uninstrumented.score)
    } finally {
      dateNow.mockRestore()
    }
  })

  it('uses canonical placement and unplaced-id tie-breaks before incumbent fallback', async () => {
    const sources = await sourcesPromise
    const geometrySettings = settings({
      gaEnabled: false,
      baselineOnly: true,
      gaEvaluationBudget: 0,
      gaGenerationBudget: 0,
      gaTimeBudgetMs: 0
    })
    const result = await Effect.runPromise(run(request(sources), geometrySettings))
    const scorer = await makeLayoutScorer(geometrySettings)
    const baselineScore = {
      ...result.score,
      placementOrder: [PieceId.make('z-placement')],
      unplacedSourcePieceIds: [PieceId.make('z-unplaced')]
    }
    const placementTieBreakScore = {
      ...baselineScore,
      placementOrder: [PieceId.make('a-placement')]
    }
    const placementSelection = selectBetterIrregularPortfolioCandidate(
      {
        chromosomeKey: 'baseline',
        score: baselineScore,
        value: 'baseline'
      },
      {
        chromosomeKey: 'candidate',
        score: placementTieBreakScore,
        value: 'candidate'
      },
      scorer,
      'baseline'
    )

    expect(scorer.compare(placementTieBreakScore, baselineScore)).toBeLessThan(0)
    expect(placementSelection).toBe('candidate')

    const unplacedTieBreakScore = {
      ...baselineScore,
      unplacedSourcePieceIds: [PieceId.make('a-unplaced')]
    }
    const unplacedSelection = selectBetterIrregularPortfolioCandidate(
      {
        chromosomeKey: 'baseline',
        score: baselineScore,
        value: 'baseline'
      },
      {
        chromosomeKey: 'candidate',
        score: unplacedTieBreakScore,
        value: 'candidate'
      },
      scorer,
      'baseline'
    )

    expect(scorer.compare(unplacedTieBreakScore, baselineScore)).toBeLessThan(0)
    expect(unplacedSelection).toBe('candidate')

    const exactTieSelection = selectBetterIrregularPortfolioCandidate(
      {
        chromosomeKey: 'baseline',
        score: baselineScore,
        value: 'baseline'
      },
      {
        chromosomeKey: 'candidate',
        score: baselineScore,
        value: 'candidate'
      },
      scorer,
      'baseline'
    )

    expect(exactTieSelection).toBe('baseline')
  })

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
      ...Array.from({ length: 8 }, () => 'ga_search')
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
    expect(result.portfolio.terminationReason).toBe('cancelled')
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
    expect(budgetResult.portfolio.terminationReason).toBe('evaluation_budget')
    expect(
      budgetResult.portfolio.placements.length + budgetResult.portfolio.unplacedPieceIds.length
    ).toBe(sources.length)
    expect(budgetProgress.at(-1)?.phase).toBe('ga_search')
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
    expect(completedResult.portfolio.terminationReason).toBe('ga_disabled')
    expect(completedResult.portfolio.source).toBe('beam')
    expect(completedProgress.map(({ phase }) => phase)).toEqual(['deterministic_beam'])
  })

  it('reuses the baseline for equivalent GA chromosomes without extra decodes', async () => {
    const sources = await sourcesPromise
    const phaseMeasurements: string[] = []
    const result = await Effect.runPromise(
      run(request(sources), settings({
        gaPopulation: 4,
        gaGenerationBudget: 2,
        gaEvaluationBudget: 8,
        priorityOrderMutationEnabled: false,
        transformPreferenceMutationEnabled: false,
        placementPolicyMutationEnabled: false
      }), {
        onPortfolioPhase: (measurement) => {
          phaseMeasurements.push(measurement.phase)
        }
      })
    )

    expect(phaseMeasurements).toEqual(['baseline-decode'])
    expect(result.portfolio.source).toBe('beam')
    expect(result.portfolio.placements.length + result.portfolio.unplacedPieceIds.length).toBe(
      sources.length
    )
  })

  it('discards a cancelled in-progress GA decode and keeps the completed baseline', async () => {
    const sources = await sourcesPromise
    let baselineComplete = false
    let checksAfterBaseline = 0
    const phaseMeasurements: string[] = []
    const result = await Effect.runPromise(
      run(request(sources), settings(), {
        onPortfolioPhase: (measurement) => {
          phaseMeasurements.push(measurement.phase)
          if (measurement.phase === 'baseline-decode') baselineComplete = true
        },
        isCancelled: () => {
          if (!baselineComplete) return false
          checksAfterBaseline += 1
          return checksAfterBaseline > 2
        }
      })
    )

    expect(result.portfolio.status).toBe('cancelled')
    expect(result.portfolio.source).toBe('beam')
    expect(phaseMeasurements).toEqual(['baseline-decode'])
    expect(result.portfolio.placements.length + result.portfolio.unplacedPieceIds.length).toBe(
      sources.length
    )
  })

  it('charges a cached baseline slot without materializing history when history is off', async () => {
    const sources = await sourcesPromise
    const phaseMeasurements: string[] = []
    const progress: IrregularPortfolioProgress[] = []
    const result = await Effect.runPromise(
      run(request(sources), settings({ gaEvaluationBudget: 1 }), {
        emitStateSnapshot: () => {},
        emitPortfolioProgress: (nextProgress) => {
          progress.push(nextProgress)
          return Effect.void
        },
        onPortfolioPhase: (measurement) => {
          phaseMeasurements.push(measurement.phase)
        }
      })
    )

    expect(phaseMeasurements).toEqual(['baseline-decode'])
    expect(progress.at(-1)?.evaluationsCompleted).toBe(1)
    expect(result.stateSnapshots).toEqual([])
  })

  it('captures GA portfolio history only when history is enabled', async () => {
    const sources = await sourcesPromise
    const emittedOff: IrregularPortfolioProgress[] = []
    const emittedOn: IrregularPortfolioProgress[] = []
    const offSnapshots: number[] = []
    const onSnapshots: number[] = []

    const offResult = await Effect.runPromise(
      run(request(sources, 'off'), settings({ gaEvaluationBudget: 1 }), {
        emitStateSnapshot: (snapshot) => offSnapshots.push(snapshot.stepIndex),
        emitPortfolioProgress: (progress) => {
          emittedOff.push(progress)
          return Effect.void
        }
      })
    )
    const onResult = await Effect.runPromise(
      run(request(sources, 'final'), settings({ gaEvaluationBudget: 1 }), {
        emitStateSnapshot: (snapshot) => onSnapshots.push(snapshot.stepIndex),
        emitPortfolioProgress: (progress) => {
          emittedOn.push(progress)
          return Effect.void
        }
      })
    )

    expect(offResult.stateSnapshots).toEqual([])
    expect(offSnapshots).toEqual([])
    expect(emittedOff.at(-1)?.phase).toBe('ga_search')
    expect(onResult.stateSnapshots.length).toBeGreaterThan(0)
    expect(onSnapshots).toEqual(onResult.stateSnapshots.map((snapshot) => snapshot.stepIndex))
    expect(emittedOn.at(-1)?.phase).toBe('validating')
  })
})
