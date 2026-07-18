import { Effect, Layer, Order } from 'effect'
import { performance } from 'node:perf_hooks'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID,
  DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS,
  IrregularLayoutScoreSummary,
  IrregularNestingSettings,
  IrregularPlacementPolicyId,
  IrregularPortfolioProgress,
  IrregularPortfolioResult,
  IrregularPreparedPiece,
  type IrregularPortfolioTerminationReason
} from '@shared/irregular/domain.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularNestingPortfolio,
  IrregularPortfolioError,
  NfpIfpService,
  PriorityOrderService,
  type RunPortfolioInput
} from '../../irregular/services.js'
import { IrregularPlacementScorer } from './irregularPlacementScorer.js'
import { IrregularLayoutScorer, type IrregularLayoutScore } from './irregularLayoutScorer.js'
import { IrregularDecisionTraceChromosomeIdRegistry } from './decisionTrace.js'
import type {
  EmitIrregularDecisionTrace,
  IrregularDecisionTraceIdentity
} from './decisionTrace.js'
import {
  IrregularWindowedBeamOptions,
  IrregularWindowedBeamAbortedError,
  IrregularWindowedBeamControl,
  IrregularWindowedBeamResult,
  runWindowedIrregularBeam
} from './windowedBeam.js'

export interface IrregularPortfolioChromosome {
  readonly priorityOrder: ReadonlyArray<PieceId>
  readonly transformPreferences: ReadonlyMap<PieceId, number>
  readonly policyId: IrregularPlacementPolicyId
}

type Chromosome = IrregularPortfolioChromosome

export interface IrregularChromosomeGeneControls {
  readonly priorityOrderMutationEnabled: boolean
  readonly transformPreferenceMutationEnabled: boolean
  readonly placementPolicyMutationEnabled: boolean
}

type ChromosomeGeneControls = IrregularChromosomeGeneControls

export interface IrregularChromosomePiece {
  readonly pieceId?: PieceId | undefined
  readonly source: { readonly id: PieceId }
  readonly transforms: ReadonlyArray<{ readonly index: number }>
}

interface EvaluatedChromosome {
  readonly chromosome: Chromosome
  readonly beam: IrregularWindowedBeamResult
  readonly score: IrregularLayoutScore
  readonly candidateCounts: ReadonlyArray<number>
  readonly snapshots: ReadonlyArray<BeamSnapshot>
}

interface BeamSnapshot {
  readonly stepIndex: number
  readonly beamRank: number
  readonly candidateCount: number
  readonly state: import('./irregularBeamState.js').IrregularBeamState
}

/** measurements exposed only to standalone benchmark callers. */
export interface IrregularPortfolioPhaseMeasurement {
  readonly phase: 'baseline-decode' | 'ga-decode' | 'replay'
  readonly elapsedMs: number
  readonly candidateCount: number
}

/** Benchmark-only counters for one irregular portfolio run. */
export interface IrregularPortfolioMetrics {
  /** GA-loop population slots consumed before the evaluation budget check stops scheduling. */
  readonly scheduledEvaluationSlots: number
  /** Distinct chromosome keys encountered in those scheduled GA-loop slots. */
  readonly distinctChromosomeKeys: number
  /** Scheduled GA-loop slots served from evaluatedByChromosome. */
  readonly evaluatedChromosomeCacheHits: number
  /** Scheduled GA-loop slots that started a new beam decode. */
  readonly evaluatedChromosomeCacheMisses: number
  /** Baseline plus every cache miss that started a full beam decode. */
  readonly actualFullBeamDecodes: number
  /** Aggregate elapsed time from successful baseline and GA decode phase hooks. */
  readonly decodedBeamElapsedMs: number
  /** Aggregate candidate count from successful baseline and GA decode phase hooks. */
  readonly decodedBeamCandidateCount: number
}

/** optional measurement sink; normal worker results do not contain these values. */
export interface IrregularPortfolioInstrumentation {
  readonly onPhase?: (measurement: IrregularPortfolioPhaseMeasurement) => void
  readonly onMetrics?: (metrics: IrregularPortfolioMetrics) => void
}

interface PortfolioRunInput extends RunPortfolioInput {
  readonly instrumentation?: IrregularPortfolioInstrumentation
}

interface PortfolioDependencies {
  readonly settings: IrregularNestingSettings
  readonly priorityOrderService: PriorityOrderService
  readonly geometryKernel: GeometryKernel.Service
  readonly nfpIfpService: NfpIfpService
  readonly placementScorer: IrregularPlacementScorer.Service
  readonly layoutScorer: IrregularLayoutScorer.Service
}

/** Keeps benchmark-only work out of the GA wall-clock decision budget. */
class PortfolioDeadline {
  private deadlineMs: number

  constructor(timeBudgetMs: number) {
    this.deadlineMs = Date.now() + timeBudgetMs
  }

  hasExpired(): boolean {
    return Date.now() >= this.deadlineMs
  }

  value(): number {
    return this.deadlineMs
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineMs - Date.now())
  }

  excludeInstrumentation(operation: () => void): void {
    const startedAtMs = Date.now()
    try {
      operation()
    } finally {
      this.deadlineMs += Math.max(0, Date.now() - startedAtMs)
    }
  }
}

export function makeDeterministicInitialPopulation(input: {
  readonly baseline: IrregularPortfolioChromosome
  readonly pieces: ReadonlyArray<IrregularChromosomePiece>
  readonly configuredPolicies: ReadonlyArray<IrregularPlacementPolicyId>
  readonly populationSize: number
  readonly gaSeed: string
  readonly geneControls: IrregularChromosomeGeneControls
}): ReadonlyArray<IrregularPortfolioChromosome> {
  return makeInitialPopulation(
    input.baseline,
    input.pieces,
    input.configuredPolicies,
    input.populationSize,
    new DeterministicPrng(input.gaSeed),
    input.geneControls
  )
}

/** Real deterministic implementation of the bounded irregular search portfolio. */
export const IrregularNestingPortfolioLive = Layer.effect(
  IrregularNestingPortfolio,
  Effect.gen(function* () {
    const dependencies: PortfolioDependencies = {
      settings: yield* GeometrySettings,
      priorityOrderService: yield* PriorityOrderService,
      geometryKernel: yield* GeometryKernel,
      nfpIfpService: yield* NfpIfpService,
      placementScorer: yield* IrregularPlacementScorer,
      layoutScorer: yield* IrregularLayoutScorer
    }

    return IrregularNestingPortfolio.of({
      run: (input) => runPortfolio(input, dependencies)
    })
  })
)

function runPortfolio(
  input: PortfolioRunInput,
  dependencies: PortfolioDependencies
): Effect.Effect<IrregularPortfolioResult, IrregularPortfolioError> {
  return Effect.gen(function* () {
    const metrics =
      input.instrumentation?.onMetrics === undefined
        ? undefined
        : new IrregularPortfolioMetricsCollector()
    const startedAtMs = Date.now()
    const settings = dependencies.settings
    const decisionTraceChromosomeIds =
      input.emitDecisionTrace === undefined
        ? undefined
        : new IrregularDecisionTraceChromosomeIdRegistry()
    const allPieceIds = input.pieces.map(preparedPieceId)
    const baselineOrder = yield* dependencies.priorityOrderService
      .buildPriorityOrder({ pieces: input.pieces, settings: settings.optimizer })
      .pipe(Effect.mapError((error) => toPortfolioError(error, 'buildPriorityOrder')))
    const baselinePieces = orderPieces(input.pieces, baselineOrder)
    if (baselinePieces === undefined) {
      return yield* failPortfolio(
        'buildPriorityOrder',
        'search',
        'priority ordering did not contain every prepared piece.'
      )
    }

    if (input.isCancelled?.() === true) {
      return finishPortfolio(input, metrics, emptyPortfolioResult('cancelled', allPieceIds))
    }

    const configuredPolicies = configuredPoliciesFor(settings)
    const baselinePolicy = configuredPolicy(settings, configuredPolicies)
    const geneControls: ChromosomeGeneControls = {
      priorityOrderMutationEnabled: settings.optimizer.priorityOrderMutationEnabled ?? true,
      transformPreferenceMutationEnabled:
        settings.optimizer.transformPreferenceMutationEnabled ?? true,
      placementPolicyMutationEnabled: settings.optimizer.placementPolicyMutationEnabled ?? true
    }
    const baselineChromosome: Chromosome = {
      priorityOrder: baselineOrder,
      transformPreferences: new Map(),
      policyId: baselinePolicy
    }

    yield* reportProgress(input, {
      phase: 'deterministic_beam',
      generation: 0,
      evaluationsCompleted: 0,
      populationSize: settings.optimizer.gaPopulation,
      elapsedMs: elapsedMs(startedAtMs),
      remainingMs: remainingMs(startedAtMs, settings.optimizer.gaTimeBudgetMs)
    })

    const runBeam = (
      chromosome: Chromosome,
      decodeId: string,
      decodeSource: IrregularDecisionTraceIdentity['decodeSource'],
      control: IrregularWindowedBeamControl | undefined = undefined
    ) =>
      decodeChromosome({
        sheet: input.sheet,
        pieces: baselinePieces,
        chromosome,
        captureSnapshots: input.onStateSnapshot !== undefined,
        ...(input.emitDecisionTrace !== undefined && decisionTraceChromosomeIds !== undefined
          ? {
              emitDecisionTrace: input.emitDecisionTrace,
              decisionTraceIdentity: {
                decodeId: prefixedDecisionTraceDecodeId(
                  input.decisionTraceDecodeIdPrefix,
                  decodeId
                ),
                chromosomeId: decisionTraceChromosomeIds.idFor(chromosomeKey(chromosome)),
                decodeSource
              }
            }
          : {}),
        ...(control !== undefined ? { control } : {}),
        dependencies
      })

    const gaEnabled = gaIsEnabled(settings)
    const baselineStartedAt = input.instrumentation === undefined ? 0 : performance.now()
    metrics?.recordFullBeamDecode()
    const baselineOutcome = yield* decodeWithOutcome(
      runBeam(
        baselineChromosome,
        'baseline-0',
        'baseline',
        input.isCancelled === undefined ? undefined : { isCancelled: input.isCancelled }
      )
    )
    if (baselineOutcome._tag === 'failure') {
      if (isBeamAbortError(baselineOutcome.error)) {
        if (baselineOutcome.error.reason === 'cancelled') {
          return finishPortfolio(input, metrics, emptyPortfolioResult('cancelled', allPieceIds))
        }
        return yield* failPortfolio(
          'decodeChromosome',
          'search',
          baselineOutcome.error.message
        )
      }
      return yield* Effect.fail(baselineOutcome.error)
    }
    const baseline = baselineOutcome.value
    reportPhaseMeasurement(input, metrics, undefined, 'baseline-decode', baselineStartedAt, baseline)
    let bestOverall: EvaluatedChromosome = baseline

    if (!gaEnabled) {
      input.onSelectedState?.(baseline.beam.bestState)
      emitSnapshots(input, baseline, settings.optimizer.beamWidth)
      return finishPortfolio(
        input,
        metrics,
        portfolioResultFrom(baseline, 'beam', 'completed', 'ga_disabled', baseline.score)
      )
    }

    const random = new DeterministicPrng(settings.optimizer.gaSeed)
    const initialPopulation = makeInitialPopulation(
      baselineChromosome,
      baselinePieces,
      configuredPolicies,
      settings.optimizer.gaPopulation,
      random,
      geneControls
    )
    const evaluationBudget = settings.optimizer.gaEvaluationBudget
    const deadline = new PortfolioDeadline(settings.optimizer.gaTimeBudgetMs)
    let evaluationsCompleted = 0
    let generation = 0
    let population = initialPopulation
    let terminalStatus: 'budget-expired' | 'cancelled' | undefined
    let terminationReason: IrregularPortfolioTerminationReason | undefined
    let bestGa: EvaluatedChromosome | undefined
    const evaluatedByChromosome = new Map<string, EvaluatedChromosome>([
      [chromosomeKey(baselineChromosome), baseline]
    ])
    const baselineKey = chromosomeKey(baselineChromosome)

    while (
      population.length > 0 &&
      terminalStatus === undefined &&
      generation < (settings.optimizer.gaGenerationBudget ?? 4)
    ) {
      const generationResults: EvaluatedChromosome[] = []
      for (const chromosome of population) {
        if (input.isCancelled?.() === true) {
          terminalStatus = 'cancelled'
          terminationReason = 'cancelled'
          break
        }
        if (deadline.hasExpired()) {
          terminalStatus = 'budget-expired'
          terminationReason = 'time_budget'
          break
        }
        if (evaluationBudget !== undefined && evaluationsCompleted >= evaluationBudget) {
          terminalStatus = 'budget-expired'
          terminationReason = 'evaluation_budget'
          break
        }

        const key = chromosomeKey(chromosome)
        /** cached chromosomes still consume their scheduled GA slots. */
        evaluationsCompleted += 1
        recordPortfolioMetric(deadline, metrics, (collector) => {
          collector.recordScheduledEvaluationSlot(key)
        })
        const cachedEvaluation = evaluatedByChromosome.get(key)
        let evaluated: EvaluatedChromosome
        if (cachedEvaluation !== undefined) {
          recordPortfolioMetric(deadline, metrics, (collector) => {
            collector.recordCacheHit()
          })
          evaluated = cachedEvaluation
        } else {
          recordPortfolioMetric(deadline, metrics, (collector) => {
            collector.recordCacheMiss()
            collector.recordFullBeamDecode()
          })
          let gaDecodeStartedAt = 0
          if (input.instrumentation !== undefined) {
            deadline.excludeInstrumentation(() => {
              gaDecodeStartedAt = performance.now()
            })
          }
          const outcome = yield* decodeWithOutcome(
            runBeam(
              chromosome,
              `ga-${generation}-${evaluationsCompleted}`,
              'ga',
              {
                deadlineMs: deadline.value(),
                ...(input.isCancelled !== undefined ? { isCancelled: input.isCancelled } : {})
              }
            )
          )
          if (outcome._tag === 'failure') {
            if (isBeamAbortError(outcome.error)) {
              terminalStatus =
                outcome.error.reason === 'cancelled' ? 'cancelled' : 'budget-expired'
              terminationReason =
                outcome.error.reason === 'cancelled' ? 'cancelled' : 'time_budget'
              break
            }
            return yield* Effect.fail(outcome.error)
          }
          evaluated = outcome.value
          evaluatedByChromosome.set(key, evaluated)
          reportPhaseMeasurement(input, metrics, deadline, 'ga-decode', gaDecodeStartedAt, evaluated)
        }
        generationResults.push(evaluated)
        if (key !== baselineKey) {
          bestGa = chooseBetter(bestGa, evaluated, dependencies.layoutScorer)
        }
        bestOverall = chooseBetter(
          bestOverall,
          evaluated,
          dependencies.layoutScorer,
          baselineKey
        )
        yield* reportProgress(input, {
          phase: 'ga_search',
          generation,
          evaluationsCompleted,
          populationSize: settings.optimizer.gaPopulation,
          bestScore: scoreSummary(bestOverall.score),
          bestSource: sourceFor(bestOverall, baselineKey),
          elapsedMs: elapsedMs(startedAtMs),
          remainingMs: deadline.remainingMs()
        })
      }

      if (terminalStatus !== undefined || generationResults.length < population.length) break
      generation += 1
      population = nextPopulation(
        baselineChromosome,
        generationResults.toSorted(evaluatedOrder(dependencies.layoutScorer)),
        baselinePieces,
        configuredPolicies,
        random,
        settings.optimizer.gaPopulation,
        geneControls
      )
    }

    if (terminalStatus === undefined) {
      terminalStatus = 'budget-expired'
      terminationReason = 'generation_budget'
    }
    const selected = chooseBetter(
      bestOverall,
      bestGa,
      dependencies.layoutScorer,
      baselineKey
    )
    if (input.isCancelled?.() === true) {
      terminalStatus = 'cancelled'
      terminationReason = 'cancelled'
    }

    input.onSelectedState?.(selected.beam.bestState)

    if (input.onStateSnapshot === undefined) {
      return finishPortfolio(
        input,
        metrics,
        portfolioResultFrom(
          selected,
          sourceFor(selected, baselineKey),
          terminalStatus,
          terminationReason ?? 'generation_budget',
          selected.score
        )
      )
    }

    const selectedSource = sourceFor(selected, baselineKey)
    yield* reportProgress(input, {
      phase: 'validating',
      generation,
      evaluationsCompleted,
      populationSize: settings.optimizer.gaPopulation,
      bestScore: scoreSummary(selected.score),
      bestSource: selectedSource,
      elapsedMs: elapsedMs(startedAtMs),
      remainingMs: deadline.remainingMs()
    })
    emitSnapshots(input, selected, settings.optimizer.beamWidth)
    return finishPortfolio(
      input,
      metrics,
      portfolioResultFrom(
        selected,
        selectedSource,
        terminalStatus,
        terminationReason ?? 'generation_budget',
        selected.score
      )
    )
  })
}

export function prefixedDecisionTraceDecodeId(
  prefix: string | undefined,
  decodeId: string
): string {
  return prefix === undefined ? decodeId : `${prefix}${decodeId}`
}

function decodeChromosome(input: {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
  readonly chromosome: Chromosome
  readonly captureSnapshots: boolean
  readonly control?: IrregularWindowedBeamControl
  readonly emitDecisionTrace?: EmitIrregularDecisionTrace
  readonly decisionTraceIdentity?: IrregularDecisionTraceIdentity
  readonly dependencies: PortfolioDependencies
}): Effect.Effect<
  EvaluatedChromosome,
  IrregularPortfolioError | IrregularWindowedBeamAbortedError
> {
  const orderedPieces = orderPieces(input.pieces, input.chromosome.priorityOrder)
  if (orderedPieces === undefined) {
    return failPortfolio(
      'decodeChromosome',
      'search',
      'chromosome priority order did not contain every prepared piece.'
    )
  }
  const options: IrregularWindowedBeamOptions = {
    policyId: input.chromosome.policyId,
    transformPreferences: input.chromosome.transformPreferences
  }
  const snapshots: BeamSnapshot[] = []
  const hooks = input.captureSnapshots
    ? {
        onInitialState: (state: import('./irregularBeamState.js').IrregularBeamState) => {
          snapshots.push({ stepIndex: 0, beamRank: 0, candidateCount: 0, state })
        },
        onStateSelected: (snapshot: BeamSnapshot) => {
          snapshots.push(snapshot)
        }
      }
    : undefined
  return runWindowedIrregularBeam({
    sheet: input.sheet,
    pieces: orderedPieces,
    options,
    ...(hooks !== undefined ? { hooks } : {}),
    ...(input.control !== undefined ? { control: input.control } : {}),
    ...(input.emitDecisionTrace !== undefined && input.decisionTraceIdentity !== undefined
      ? {
          emitDecisionTrace: input.emitDecisionTrace,
          decisionTraceIdentity: input.decisionTraceIdentity
        }
      : {})
  }).pipe(
    Effect.provideService(GeometrySettings, input.dependencies.settings),
    Effect.provideService(GeometryKernel, input.dependencies.geometryKernel),
    Effect.provideService(NfpIfpService, input.dependencies.nfpIfpService),
    Effect.provideService(IrregularPlacementScorer, input.dependencies.placementScorer),
    Effect.provideService(IrregularLayoutScorer, input.dependencies.layoutScorer),
    Effect.map((beam) => ({
      chromosome: input.chromosome,
      beam,
      score: beam.bestScore,
      candidateCounts: beam.candidateCounts,
      snapshots
    })),
    Effect.mapError((error) => {
      if (error._tag === 'IrregularWindowedBeamAbortedError') return error
      if (error._tag === 'IrregularNfpIfpControlAbortError') {
        return new IrregularWindowedBeamAbortedError({
          reason: error.reason,
          message: error.message
        })
      }
      return toPortfolioError(error, 'decodeChromosome')
    })
  )
}

function makeInitialPopulation(
  baseline: Chromosome,
  pieces: ReadonlyArray<IrregularChromosomePiece>,
  configuredPolicies: ReadonlyArray<IrregularPlacementPolicyId>,
  populationSize: number,
  random: DeterministicPrng,
  geneControls: ChromosomeGeneControls
): ReadonlyArray<Chromosome> {
  const population: Chromosome[] = [baseline]
  const seen = new Set([chromosomeKey(baseline)])
  const enabledGenes = enabledMutationGenes(geneControls)
  if (enabledGenes.length === 0) {
    return fillPopulation(population, baseline, populationSize)
  }

  let compatibilityCandidate = baseline
  const compatibilityMutationCount = 1 + (population.length % 3)
  for (let mutationIndex = 0; mutationIndex < compatibilityMutationCount; mutationIndex += 1) {
    compatibilityCandidate = mutateChromosome(
      compatibilityCandidate,
      pieces,
      configuredPolicies,
      random,
      geneControls
    )
  }
  addUniqueChromosome(population, seen, compatibilityCandidate)

  for (const plan of initialMutationPlans(enabledGenes, populationSize)) {
    if (population.length >= populationSize) break
    const candidate = applyMutationPlan(
      baseline,
      plan,
      pieces,
      configuredPolicies,
      random,
      geneControls
    )
    addUniqueChromosome(population, seen, candidate)
  }

  const maximumFallbackAttempts = Math.max(8, populationSize * 4)
  let fallbackAttempt = 0
  while (population.length < populationSize && fallbackAttempt < maximumFallbackAttempts) {
    const mutationCount = 1 + random.nextInt(Math.min(4, enabledGenes.length + 1))
    const plan: ChromosomeMutationGene[] = []
    for (let mutationIndex = 0; mutationIndex < mutationCount; mutationIndex += 1) {
      const gene = enabledGenes[random.nextInt(enabledGenes.length)]
      if (gene !== undefined) plan.push(gene)
    }
    const candidate = applyMutationPlan(
      baseline,
      plan,
      pieces,
      configuredPolicies,
      random,
      geneControls
    )
    addUniqueChromosome(population, seen, candidate)
    fallbackAttempt += 1
  }

  return fillPopulation(population, baseline, populationSize)
}

function nextPopulation(
  baseline: Chromosome,
  scored: ReadonlyArray<EvaluatedChromosome>,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  configuredPolicies: ReadonlyArray<IrregularPlacementPolicyId>,
  random: DeterministicPrng,
  populationSize: number,
  geneControls: ChromosomeGeneControls
): ReadonlyArray<Chromosome> {
  const eliteCount = Math.max(1, Math.floor(populationSize / 8))
  const elites = scored.slice(0, eliteCount).map(({ chromosome }) => chromosome)
  const parentPool = scored.slice(0, Math.max(1, Math.ceil(scored.length / 2)))
  const baselineKey = chromosomeKey(baseline)
  const next: Chromosome[] = [baseline]
  for (const elite of elites) {
    if (next.length >= populationSize) break
    if (chromosomeKey(elite) !== baselineKey) next.push(elite)
  }
  while (next.length < populationSize) {
    const firstParent = parentPool[random.nextInt(parentPool.length)]
    const secondParent = parentPool[random.nextInt(parentPool.length)]
    if (firstParent === undefined || secondParent === undefined) break
    const child = crossoverChromosomes(
      firstParent.chromosome,
      secondParent.chromosome,
      random,
      geneControls
    )
    next.push(
      hasEnabledGene(geneControls) && random.chance(0.85)
        ? mutateChromosome(child, pieces, configuredPolicies, random, geneControls)
        : child
    )
  }
  return next
}

type ChromosomeMutationGene =
  | 'priority-order'
  | 'transform-preference'
  | 'placement-policy'

function enabledMutationGenes(
  controls: ChromosomeGeneControls
): ReadonlyArray<ChromosomeMutationGene> {
  const genes: ChromosomeMutationGene[] = []
  if (controls.priorityOrderMutationEnabled) genes.push('priority-order')
  if (controls.transformPreferenceMutationEnabled) genes.push('transform-preference')
  if (controls.placementPolicyMutationEnabled) genes.push('placement-policy')
  return genes
}

function initialMutationPlans(
  enabledGenes: ReadonlyArray<ChromosomeMutationGene>,
  populationSize: number
): ReadonlyArray<ReadonlyArray<ChromosomeMutationGene>> {
  const plans: ChromosomeMutationGene[][] = []
  for (let seedIndex = 0; seedIndex < populationSize - 1; seedIndex += 1) {
    const mutationCount = Math.min(4, 1 + Math.floor(seedIndex / enabledGenes.length))
    const plan: ChromosomeMutationGene[] = []
    for (let mutationIndex = 0; mutationIndex < mutationCount; mutationIndex += 1) {
      const gene = enabledGenes[(seedIndex + mutationIndex) % enabledGenes.length]
      if (gene !== undefined) plan.push(gene)
    }
    plans.push(plan)
  }
  return plans
}

function applyMutationPlan(
  baseline: Chromosome,
  plan: ReadonlyArray<ChromosomeMutationGene>,
  pieces: ReadonlyArray<IrregularChromosomePiece>,
  configuredPolicies: ReadonlyArray<IrregularPlacementPolicyId>,
  random: DeterministicPrng,
  geneControls: ChromosomeGeneControls
): Chromosome {
  let candidate = baseline
  for (const gene of plan) {
    candidate = mutateChromosome(
      candidate,
      pieces,
      configuredPolicies,
      random,
      geneControls,
      gene
    )
  }
  return candidate
}

function addUniqueChromosome(
  population: Chromosome[],
  seen: Set<string>,
  candidate: Chromosome
): void {
  const key = chromosomeKey(candidate)
  if (seen.has(key)) return
  seen.add(key)
  population.push(candidate)
}

function fillPopulation(
  population: Chromosome[],
  baseline: Chromosome,
  populationSize: number
): ReadonlyArray<Chromosome> {
  while (population.length < populationSize) population.push(baseline)
  return population
}

function crossoverChromosomes(
  first: Chromosome,
  second: Chromosome,
  random: DeterministicPrng,
  geneControls: ChromosomeGeneControls
): Chromosome {
  const length = first.priorityOrder.length
  const priorityOrder = geneControls.priorityOrderMutationEnabled
    ? crossoverPriorityOrder(first.priorityOrder, second.priorityOrder, random)
    : [...first.priorityOrder]
  const transformPreferences = geneControls.transformPreferenceMutationEnabled
    ? crossoverTransformPreferences(priorityOrder, first, second, random)
    : new Map(first.transformPreferences)
  const policyId = geneControls.placementPolicyMutationEnabled
    ? random.chance(0.5)
      ? first.policyId
      : second.policyId
    : first.policyId
  if (length < 2) {
    return { priorityOrder, transformPreferences, policyId }
  }
  return { priorityOrder, transformPreferences, policyId }
}

function crossoverPriorityOrder(
  firstOrder: ReadonlyArray<PieceId>,
  secondOrder: ReadonlyArray<PieceId>,
  random: DeterministicPrng
): ReadonlyArray<PieceId> {
  const length = firstOrder.length
  const firstCut = random.nextInt(length)
  const secondCut = random.nextInt(length)
  const start = Math.min(firstCut, secondCut)
  const end = Math.max(firstCut, secondCut)
  const child: Array<PieceId | undefined> = Array.from({ length }, () => undefined)
  const present = new Set<PieceId>()
  for (let index = start; index <= end; index += 1) {
    const pieceId = firstOrder[index]
    if (pieceId === undefined) continue
    child[index] = pieceId
    present.add(pieceId)
  }
  let childIndex = (end + 1) % length
  for (let sourceIndex = 0; sourceIndex < length; sourceIndex += 1) {
    const pieceId = secondOrder[(end + 1 + sourceIndex) % length]
    if (pieceId === undefined || present.has(pieceId)) continue
    child[childIndex] = pieceId
    present.add(pieceId)
    childIndex = (childIndex + 1) % length
  }
  return child.every((pieceId): pieceId is PieceId => pieceId !== undefined)
    ? child
    : [...firstOrder]
}

function crossoverTransformPreferences(
  priorityOrder: ReadonlyArray<PieceId>,
  first: Chromosome,
  second: Chromosome,
  random: DeterministicPrng
): ReadonlyMap<PieceId, number> {
  const transformPreferences = new Map<PieceId, number>()
  for (const pieceId of priorityOrder) {
    const firstPreference = first.transformPreferences.get(pieceId)
    const secondPreference = second.transformPreferences.get(pieceId)
    const preference = random.chance(0.5) ? firstPreference : secondPreference
    if (preference !== undefined) transformPreferences.set(pieceId, preference)
  }
  return transformPreferences
}

function mutateChromosome(
  chromosome: Chromosome,
  pieces: ReadonlyArray<IrregularChromosomePiece>,
  configuredPolicies: ReadonlyArray<IrregularPlacementPolicyId>,
  random: DeterministicPrng,
  geneControls: ChromosomeGeneControls,
  preferredGene: ChromosomeMutationGene | undefined = undefined
): Chromosome {
  const priorityOrder = [...chromosome.priorityOrder]
  if (
    geneControls.priorityOrderMutationEnabled &&
    (preferredGene === undefined || preferredGene === 'priority-order') &&
    priorityOrder.length > 1
  ) {
    const operation = preferredGene === 'priority-order' ? 0 : random.nextInt(3)
    if (operation === 0) {
      const firstIndex = random.nextInt(priorityOrder.length)
      const secondIndex =
        preferredGene === 'priority-order'
          ? differentIndex(random, priorityOrder.length, firstIndex)
          : random.nextInt(priorityOrder.length)
      const firstPiece = priorityOrder[firstIndex]
      const secondPiece = priorityOrder[secondIndex]
      if (firstPiece !== undefined && secondPiece !== undefined) {
        priorityOrder[firstIndex] = secondPiece
        priorityOrder[secondIndex] = firstPiece
      }
    } else if (operation === 1) {
      const fromIndex = random.nextInt(priorityOrder.length)
      const [pieceId] = priorityOrder.splice(fromIndex, 1)
      if (pieceId !== undefined) {
        const toIndex = random.nextInt(priorityOrder.length + 1)
        priorityOrder.splice(toIndex, 0, pieceId)
      }
    } else {
      const firstIndex = random.nextInt(priorityOrder.length)
      const secondIndex = random.nextInt(priorityOrder.length)
      const start = Math.min(firstIndex, secondIndex)
      const end = Math.max(firstIndex, secondIndex)
      priorityOrder.splice(start, end - start + 1, ...priorityOrder.slice(start, end + 1).reverse())
    }
  }

  const transformPreferences = new Map(chromosome.transformPreferences)
  if (
    geneControls.transformPreferenceMutationEnabled &&
    (preferredGene === undefined || preferredGene === 'transform-preference') &&
    pieces.length > 0
  ) {
    const piece = pieces[random.nextInt(pieces.length)]
    if (piece !== undefined && piece.transforms.length > 0) {
      const pieceId = preparedPieceId(piece)
      const currentPreference = transformPreferences.get(pieceId)
      const availableTransforms =
        preferredGene === 'transform-preference'
          ? piece.transforms.filter(({ index }) => index !== currentPreference)
          : piece.transforms
      const transform =
        availableTransforms.length === 0
          ? undefined
          : availableTransforms[random.nextInt(availableTransforms.length)]
      if (transform !== undefined) transformPreferences.set(pieceId, transform.index)
    }
  }

  const policyCandidates =
    preferredGene === 'placement-policy'
      ? configuredPolicies.filter((policyId) => policyId !== chromosome.policyId)
      : configuredPolicies
  const policyId =
    geneControls.placementPolicyMutationEnabled &&
    (preferredGene === undefined || preferredGene === 'placement-policy') &&
    configuredPolicies.length > 0 &&
    policyCandidates.length > 0 &&
    (preferredGene === 'placement-policy' || random.chance(0.35))
      ? (policyCandidates[random.nextInt(policyCandidates.length)] ?? chromosome.policyId)
      : chromosome.policyId
  return { priorityOrder, transformPreferences, policyId }
}

function differentIndex(random: DeterministicPrng, length: number, excluded: number): number {
  return (excluded + 1 + random.nextInt(length - 1)) % length
}

function chooseBetter(
  first: EvaluatedChromosome | undefined,
  second: EvaluatedChromosome | undefined,
  scorer: IrregularLayoutScorer.Service,
  preferredChromosomeKey: string | undefined = undefined
): EvaluatedChromosome {
  if (first === undefined && second === undefined) {
    throw new Error('portfolio requires at least one validated layout')
  }
  if (first === undefined) {
    if (second === undefined) throw new Error('portfolio requires at least one validated layout')
    return second
  }
  if (second === undefined) return first
  return selectBetterIrregularPortfolioCandidate(
    {
      chromosomeKey: chromosomeKey(first.chromosome),
      score: first.score,
      value: first
    },
    {
      chromosomeKey: chromosomeKey(second.chromosome),
      score: second.score,
      value: second
    },
    scorer,
    preferredChromosomeKey
  )
}

export function selectBetterIrregularPortfolioCandidate<T>(
  first: {
    readonly chromosomeKey: string
    readonly score: IrregularLayoutScore
    readonly value: T
  },
  second: {
    readonly chromosomeKey: string
    readonly score: IrregularLayoutScore
    readonly value: T
  },
  scorer: IrregularLayoutScorer.Service,
  preferredChromosomeKey: string | undefined = undefined
): T {
  const comparison = scorer.compare(second.score, first.score)
  if (comparison < 0) return second.value
  if (comparison > 0) return first.value
  if (preferredChromosomeKey !== undefined) {
    const firstIsPreferred = first.chromosomeKey === preferredChromosomeKey
    const secondIsPreferred = second.chromosomeKey === preferredChromosomeKey
    if (firstIsPreferred && !secondIsPreferred) return first.value
    if (secondIsPreferred && !firstIsPreferred) return second.value
  }
  return second.chromosomeKey < first.chromosomeKey ? second.value : first.value
}

function evaluatedOrder(scorer: IrregularLayoutScorer.Service): Order.Order<EvaluatedChromosome> {
  return Order.combineAll([
    Order.make((first, second) => scorer.compare(first.score, second.score)),
    Order.mapInput(Order.String, ({ chromosome }) => chromosomeKey(chromosome))
  ])
}

function orderPieces(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  priorityOrder: ReadonlyArray<PieceId>
): ReadonlyArray<IrregularPreparedPiece> | undefined {
  const byId = new Map(pieces.map((piece) => [preparedPieceId(piece), piece]))
  const ordered: IrregularPreparedPiece[] = []
  for (const pieceId of priorityOrder) {
    const piece = byId.get(pieceId)
    if (piece === undefined) return undefined
    ordered.push(piece)
  }
  return ordered.length === pieces.length ? ordered : undefined
}

function configuredPoliciesFor(
  settings: IrregularNestingSettings
): ReadonlyArray<IrregularPlacementPolicyId> {
  const configured = settings.optimizer.placementPolicyIds ?? DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS
  const unique = [...new Set(configured)]
  return unique.length === 0 ? [DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID] : unique
}

function configuredPolicy(
  settings: IrregularNestingSettings,
  policies: ReadonlyArray<IrregularPlacementPolicyId>
): IrregularPlacementPolicyId {
  const selected = settings.optimizer.placementPolicyId
  return selected !== undefined && policies.includes(selected)
    ? selected
    : (policies[0] ?? DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID)
}

function gaIsEnabled(settings: IrregularNestingSettings): boolean {
  return (
    settings.optimizer.gaEnabled !== false &&
    settings.optimizer.baselineOnly !== true &&
    settings.optimizer.gaTimeBudgetMs > 0 &&
    (settings.optimizer.gaGenerationBudget ?? 4) > 0 &&
    (settings.optimizer.gaEvaluationBudget ?? 128) > 0
  )
}

function hasEnabledGene(controls: ChromosomeGeneControls): boolean {
  return (
    controls.priorityOrderMutationEnabled ||
    controls.transformPreferenceMutationEnabled ||
    controls.placementPolicyMutationEnabled
  )
}

function portfolioResultFrom(
  evaluated: EvaluatedChromosome,
  source: 'beam' | 'ga',
  status: 'completed' | 'budget-expired' | 'cancelled',
  terminationReason: IrregularPortfolioTerminationReason,
  score: IrregularLayoutScore
): IrregularPortfolioResult {
  return new IrregularPortfolioResult({
    status,
    terminationReason,
    source,
    placements: evaluated.beam.bestState.placedCollisionGeometries.map(
      ({ placement }) => placement
    ),
    unplacedPieceIds: evaluated.beam.bestState.unplacedPieceIds,
    score: scoreSummary(score),
    diagnostics: []
  })
}

function emptyPortfolioResult(
  status: 'cancelled' | 'no-valid-result',
  unplacedPieceIds: ReadonlyArray<PieceId>
): IrregularPortfolioResult {
  return new IrregularPortfolioResult({
    status,
    terminationReason: status === 'cancelled' ? 'cancelled' : 'no_valid_result',
    source: 'none',
    placements: [],
    unplacedPieceIds: [...unplacedPieceIds].toSorted(),
    diagnostics: []
  })
}

function scoreSummary(score: IrregularLayoutScore): IrregularLayoutScoreSummary {
  return new IrregularLayoutScoreSummary({
    unplacedCount: score.unplacedCount,
    sharedCollisionBoundaryLengthMm: score.sharedCollisionBoundaryLengthMm,
    sharedCollisionBoundaryContactUnits: score.sharedCollisionBoundaryContactUnits,
    sharedCollisionBoundaryContactBand: score.sharedCollisionBoundaryContactBand,
    nearCompleteStructuralContactCount: score.nearCompleteStructuralContactCount,
    dominantNearCompleteStructuralContactCount:
      score.dominantNearCompleteStructuralContactCount,
    largestNetFreeMaterialRegionAreaMm2: score.largestNetFreeMaterialRegionAreaMm2,
    freeMaterialRegionCount: score.freeMaterialRegionCount,
    freeMaterialHoleCount: score.freeMaterialHoleCount,
    freeMaterialSliverMetric: score.freeMaterialSliverMetric,
    collisionBoundsWorstNormalizedSheetConsumption:
      score.collisionBoundsWorstNormalizedSheetConsumption,
    collisionBoundsNormalizedSpanSum: score.collisionBoundsNormalizedSpanSum,
    collisionBoundsAreaMm2: score.collisionBoundsAreaMm2,
    collisionBoundsSpanMm: score.collisionBoundsSpanMm
  })
}

function chromosomeKey(chromosome: Chromosome): string {
  const transforms = [...chromosome.transformPreferences.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([pieceId, transformIndex]) => `${pieceId}:${transformIndex}`)
    .join(',')
  return `${chromosome.priorityOrder.join('|')}::${transforms}::${chromosome.policyId}`
}

function preparedPieceId(piece: IrregularChromosomePiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function toPortfolioError(
  error: { readonly _tag: string; readonly message?: string },
  operation: string
): IrregularPortfolioError {
  const category =
    error._tag === 'IrregularGeometryInputError' ||
    error._tag === 'IrregularGeometryInfeasibleError'
      ? 'geometry'
      : error._tag === 'IrregularPlacementScoringError' ||
          error._tag === 'IrregularLayoutScoringError'
        ? 'scoring'
        : 'search'
  return new IrregularPortfolioError({
    operation,
    category,
    message: error.message ?? `${operation} failed.`
  })
}

function failPortfolio(
  operation: string,
  category: 'geometry' | 'scoring' | 'search',
  message: string
): Effect.Effect<never, IrregularPortfolioError> {
  return Effect.fail(new IrregularPortfolioError({ operation, category, message }))
}

function reportProgress(
  input: RunPortfolioInput,
  progress: ConstructorParameters<typeof IrregularPortfolioProgress>[0]
): Effect.Effect<void> {
  if (input.onProgress === undefined) return Effect.void
  return input.onProgress(new IrregularPortfolioProgress(progress))
}

type DecodeOutcome =
  | { readonly _tag: 'success'; readonly value: EvaluatedChromosome }
  | {
      readonly _tag: 'failure'
      readonly error: IrregularPortfolioError | IrregularWindowedBeamAbortedError
    }

function decodeWithOutcome(
  effect: Effect.Effect<
    EvaluatedChromosome,
    IrregularPortfolioError | IrregularWindowedBeamAbortedError
  >
): Effect.Effect<DecodeOutcome> {
  return Effect.matchEffect(effect, {
    onFailure: (error) => Effect.succeed({ _tag: 'failure' as const, error }),
    onSuccess: (value) => Effect.succeed({ _tag: 'success' as const, value })
  })
}

function reportPhaseMeasurement(
  input: PortfolioRunInput,
  metrics: IrregularPortfolioMetricsCollector | undefined,
  deadline: PortfolioDeadline | undefined,
  phase: IrregularPortfolioPhaseMeasurement['phase'],
  startedAtMs: number,
  evaluated: EvaluatedChromosome
): void {
  if (input.instrumentation === undefined) return
  const report = () => {
    const measurement: IrregularPortfolioPhaseMeasurement = {
      phase,
      elapsedMs: Math.max(0, performance.now() - startedAtMs),
      candidateCount: evaluated.candidateCounts.reduce(
        (candidateTotal, candidateCount) => candidateTotal + candidateCount,
        0
      )
    }
    metrics?.recordPhaseMeasurement(measurement)
    input.instrumentation?.onPhase?.(measurement)
  }
  if (deadline === undefined) {
    report()
    return
  }
  deadline.excludeInstrumentation(report)
}

function recordPortfolioMetric(
  deadline: PortfolioDeadline,
  metrics: IrregularPortfolioMetricsCollector | undefined,
  record: (collector: IrregularPortfolioMetricsCollector) => void
): void {
  if (metrics === undefined) return
  deadline.excludeInstrumentation(() => {
    record(metrics)
  })
}

function finishPortfolio(
  input: PortfolioRunInput,
  metrics: IrregularPortfolioMetricsCollector | undefined,
  result: IrregularPortfolioResult
): IrregularPortfolioResult {
  if (metrics !== undefined) input.instrumentation?.onMetrics?.(metrics.snapshot())
  return result
}

class IrregularPortfolioMetricsCollector {
  private scheduledEvaluationSlots = 0
  private readonly chromosomeKeys = new Set<string>()
  private evaluatedChromosomeCacheHits = 0
  private evaluatedChromosomeCacheMisses = 0
  private actualFullBeamDecodes = 0
  private decodedBeamElapsedMs = 0
  private decodedBeamCandidateCount = 0

  recordScheduledEvaluationSlot(chromosomeKey: string): void {
    this.scheduledEvaluationSlots += 1
    this.chromosomeKeys.add(chromosomeKey)
  }

  recordCacheHit(): void {
    this.evaluatedChromosomeCacheHits += 1
  }

  recordCacheMiss(): void {
    this.evaluatedChromosomeCacheMisses += 1
  }

  recordFullBeamDecode(): void {
    this.actualFullBeamDecodes += 1
  }

  recordPhaseMeasurement(measurement: IrregularPortfolioPhaseMeasurement): void {
    if (measurement.phase === 'replay') return
    this.decodedBeamElapsedMs += measurement.elapsedMs
    this.decodedBeamCandidateCount += measurement.candidateCount
  }

  snapshot(): IrregularPortfolioMetrics {
    return {
      scheduledEvaluationSlots: this.scheduledEvaluationSlots,
      distinctChromosomeKeys: this.chromosomeKeys.size,
      evaluatedChromosomeCacheHits: this.evaluatedChromosomeCacheHits,
      evaluatedChromosomeCacheMisses: this.evaluatedChromosomeCacheMisses,
      actualFullBeamDecodes: this.actualFullBeamDecodes,
      decodedBeamElapsedMs: this.decodedBeamElapsedMs,
      decodedBeamCandidateCount: this.decodedBeamCandidateCount
    }
  }
}

function emitSnapshots(
  input: PortfolioRunInput,
  evaluated: EvaluatedChromosome,
  beamWidth: number
): void {
  if (input.onStateSnapshot === undefined) return
  for (const snapshot of evaluated.snapshots) {
    input.onStateSnapshot(snapshot, beamWidth)
  }
}

function sourceFor(
  evaluated: EvaluatedChromosome,
  baselineKey: string
): 'beam' | 'ga' {
  return chromosomeKey(evaluated.chromosome) === baselineKey ? 'beam' : 'ga'
}

function isBeamAbortError(
  error: IrregularPortfolioError | IrregularWindowedBeamAbortedError
): error is IrregularWindowedBeamAbortedError {
  return error._tag === 'IrregularWindowedBeamAbortedError'
}

function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs)
}

function remainingMs(startedAtMs: number, budgetMs: number): number {
  return Math.max(0, budgetMs - elapsedMs(startedAtMs))
}

/** App-owned deterministic pseudo-random generator for chromosome operations. */
class DeterministicPrng {
  private state: number

  constructor(seed: string) {
    this.state = hashSeed(seed)
    if (this.state === 0) this.state = 0x6d2b79f5
  }

  nextUint(): number {
    let value = (this.state += 0x6d2b79f5)
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    this.state = value >>> 0
    return this.state
  }

  nextInt(maximumExclusive: number): number {
    if (maximumExclusive <= 1) return 0
    return this.nextUint() % maximumExclusive
  }

  chance(probability: number): boolean {
    return this.nextUint() / 0x1_0000_0000 < probability
  }
}

function hashSeed(seed: string): number {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
