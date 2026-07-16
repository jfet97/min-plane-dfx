import { Effect, Layer, Order } from 'effect'
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
  IrregularPreparedPiece
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
import { IrregularLayoutScore, IrregularLayoutScorer } from './irregularLayoutScorer.js'
import {
  IrregularWindowedBeamOptions,
  IrregularWindowedBeamResult,
  runWindowedIrregularBeam
} from './windowedBeam.js'

interface Chromosome {
  readonly priorityOrder: ReadonlyArray<PieceId>
  readonly transformPreferences: ReadonlyMap<PieceId, number>
  readonly policyId: IrregularPlacementPolicyId
}

interface ChromosomeGeneControls {
  readonly priorityOrderMutationEnabled: boolean
  readonly transformPreferenceMutationEnabled: boolean
  readonly placementPolicyMutationEnabled: boolean
}

interface EvaluatedChromosome {
  readonly chromosome: Chromosome
  readonly beam: IrregularWindowedBeamResult
  readonly score: IrregularLayoutScore
}

interface PortfolioDependencies {
  readonly settings: IrregularNestingSettings
  readonly priorityOrderService: PriorityOrderService
  readonly geometryKernel: GeometryKernel.Service
  readonly nfpIfpService: NfpIfpService
  readonly placementScorer: IrregularPlacementScorer.Service
  readonly layoutScorer: IrregularLayoutScorer.Service
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
  input: RunPortfolioInput,
  dependencies: PortfolioDependencies
): Effect.Effect<IrregularPortfolioResult, IrregularPortfolioError> {
  return Effect.gen(function* () {
    const startedAtMs = Date.now()
    const settings = dependencies.settings
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
      return emptyPortfolioResult('cancelled', allPieceIds)
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

    const runBeam = (chromosome: Chromosome, hooks = false) =>
      decodeChromosome({
        sheet: input.sheet,
        pieces: baselinePieces,
        chromosome,
        ...(hooks && input.onStateSnapshot !== undefined ? { hooks: input.onStateSnapshot } : {}),
        dependencies
      })

    const gaEnabled = gaIsEnabled(settings)
    const baseline = yield* runBeam(baselineChromosome, !gaEnabled && input.onStateSnapshot !== undefined)
    let bestOverall: EvaluatedChromosome = baseline

    if (!gaEnabled) {
      return portfolioResultFrom(baseline, 'beam', 'completed', baseline.score)
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
    const deadlineMs = Date.now() + settings.optimizer.gaTimeBudgetMs
    let evaluationsCompleted = 0
    let generation = 0
    let population = initialPopulation
    let terminalStatus: 'budget-expired' | 'cancelled' | undefined
    let bestGa: EvaluatedChromosome | undefined

    while (
      population.length > 0 &&
      terminalStatus === undefined &&
      generation < (settings.optimizer.gaGenerationBudget ?? 4)
    ) {
      const generationResults: EvaluatedChromosome[] = []
      for (const chromosome of population) {
        if (input.isCancelled?.() === true) {
          terminalStatus = 'cancelled'
          break
        }
        if (
          Date.now() >= deadlineMs ||
          (evaluationBudget !== undefined && evaluationsCompleted >= evaluationBudget)
        ) {
          terminalStatus = 'budget-expired'
          break
        }

        const evaluated = yield* runBeam(chromosome, false)
        evaluationsCompleted += 1
        generationResults.push(evaluated)
        bestGa = chooseBetter(bestGa, evaluated, dependencies.layoutScorer)
        bestOverall = chooseBetter(bestOverall, evaluated, dependencies.layoutScorer)
        yield* reportProgress(input, {
          phase: 'ga_search',
          generation,
          evaluationsCompleted,
          populationSize: settings.optimizer.gaPopulation,
          bestScore: scoreSummary(bestOverall.score),
          bestSource: bestOverall === bestGa ? 'ga' : 'beam',
          elapsedMs: elapsedMs(startedAtMs),
          remainingMs: Math.max(0, deadlineMs - Date.now())
        })
      }

      if (terminalStatus !== undefined || generationResults.length < population.length) break
      generation += 1
      population = nextPopulation(
        generationResults.toSorted(evaluatedOrder(dependencies.layoutScorer)),
        baselinePieces,
        configuredPolicies,
        random,
        settings.optimizer.gaPopulation,
        geneControls
      )
    }

    if (terminalStatus === undefined) terminalStatus = 'budget-expired'
    const selected = chooseBetter(bestOverall, bestGa, dependencies.layoutScorer)
    if (input.isCancelled?.() === true) terminalStatus = 'cancelled'

    if (input.onStateSnapshot === undefined) {
      return portfolioResultFrom(
        selected,
        selected === bestGa ? 'ga' : 'beam',
        terminalStatus,
        selected.score
      )
    }

    const selectedSource = selected === bestGa ? 'ga' : 'beam'
    yield* reportProgress(input, {
      phase: 'validating',
      generation,
      evaluationsCompleted,
      populationSize: settings.optimizer.gaPopulation,
      bestScore: scoreSummary(selected.score),
      bestSource: selectedSource,
      elapsedMs: elapsedMs(startedAtMs),
      remainingMs: Math.max(0, deadlineMs - Date.now())
    })
    const replayed = yield* runBeam(selected.chromosome, true)
    return portfolioResultFrom(replayed, selectedSource, terminalStatus, replayed.score)
  })
}

function decodeChromosome(input: {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
  readonly chromosome: Chromosome
  readonly hooks?: (
    snapshot: {
      readonly stepIndex: number
      readonly beamRank: number
      readonly candidateCount: number
      readonly state: import('./irregularBeamState.js').IrregularBeamState
    },
    beamWidth: number
  ) => void
  readonly dependencies: PortfolioDependencies
}): Effect.Effect<EvaluatedChromosome, IrregularPortfolioError> {
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
  const hooks =
    input.hooks === undefined
      ? undefined
      : {
          onInitialState: (state: import('./irregularBeamState.js').IrregularBeamState) =>
            input.hooks?.(
              { stepIndex: 0, beamRank: 0, candidateCount: 0, state },
              input.dependencies.settings.optimizer.beamWidth
            ),
          onStateSelected: (snapshot: {
            readonly stepIndex: number
            readonly beamRank: number
            readonly state: import('./irregularBeamState.js').IrregularBeamState
            readonly candidateCount: number
          }) => input.hooks?.(snapshot, input.dependencies.settings.optimizer.beamWidth)
        }

  return runWindowedIrregularBeam({
    sheet: input.sheet,
    pieces: orderedPieces,
    options,
    ...(hooks !== undefined ? { hooks } : {})
  }).pipe(
    Effect.provideService(GeometrySettings, input.dependencies.settings),
    Effect.provideService(GeometryKernel, input.dependencies.geometryKernel),
    Effect.provideService(NfpIfpService, input.dependencies.nfpIfpService),
    Effect.provideService(IrregularPlacementScorer, input.dependencies.placementScorer),
    Effect.provideService(IrregularLayoutScorer, input.dependencies.layoutScorer),
    Effect.map((beam) => ({ chromosome: input.chromosome, beam, score: beam.bestScore })),
    Effect.mapError((error) => toPortfolioError(error, 'decodeChromosome'))
  )
}

function makeInitialPopulation(
  baseline: Chromosome,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  configuredPolicies: ReadonlyArray<IrregularPlacementPolicyId>,
  populationSize: number,
  random: DeterministicPrng,
  geneControls: ChromosomeGeneControls
): ReadonlyArray<Chromosome> {
  const population: Chromosome[] = [baseline]
  while (population.length < populationSize) {
    const mutationCount = 1 + (population.length % 3)
    let candidate = baseline
    for (let mutationIndex = 0; mutationIndex < mutationCount; mutationIndex += 1) {
      candidate = mutateChromosome(candidate, pieces, configuredPolicies, random, geneControls)
    }
    population.push(candidate)
  }
  return population
}

function nextPopulation(
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
  const next: Chromosome[] = [...elites]
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
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  configuredPolicies: ReadonlyArray<IrregularPlacementPolicyId>,
  random: DeterministicPrng,
  geneControls: ChromosomeGeneControls
): Chromosome {
  const priorityOrder = [...chromosome.priorityOrder]
  if (geneControls.priorityOrderMutationEnabled && priorityOrder.length > 1) {
    const operation = random.nextInt(3)
    if (operation === 0) {
      const firstIndex = random.nextInt(priorityOrder.length)
      const secondIndex = random.nextInt(priorityOrder.length)
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
  if (geneControls.transformPreferenceMutationEnabled && pieces.length > 0) {
    const piece = pieces[random.nextInt(pieces.length)]
    if (piece !== undefined && piece.transforms.length > 0) {
      const transform = piece.transforms[random.nextInt(piece.transforms.length)]
      if (transform !== undefined) transformPreferences.set(preparedPieceId(piece), transform.index)
    }
  }

  const policyId =
    geneControls.placementPolicyMutationEnabled &&
    configuredPolicies.length > 0 &&
    random.chance(0.35)
      ? (configuredPolicies[random.nextInt(configuredPolicies.length)] ?? chromosome.policyId)
      : chromosome.policyId
  return { priorityOrder, transformPreferences, policyId }
}

function chooseBetter(
  first: EvaluatedChromosome | undefined,
  second: EvaluatedChromosome | undefined,
  scorer: IrregularLayoutScorer.Service
): EvaluatedChromosome {
  if (first === undefined && second === undefined) {
    throw new Error('portfolio requires at least one validated layout')
  }
  if (first === undefined) {
    if (second === undefined) throw new Error('portfolio requires at least one validated layout')
    return second
  }
  if (second === undefined) return first
  const comparison = scorer.compare(second.score, first.score)
  if (comparison < 0) return second
  if (comparison > 0) return first
  return chromosomeKey(second.chromosome) < chromosomeKey(first.chromosome) ? second : first
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
  score: IrregularLayoutScore
): IrregularPortfolioResult {
  return new IrregularPortfolioResult({
    status,
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
    source: 'none',
    placements: [],
    unplacedPieceIds: [...unplacedPieceIds].toSorted(),
    diagnostics: []
  })
}

function scoreSummary(score: IrregularLayoutScore): IrregularLayoutScoreSummary {
  return new IrregularLayoutScoreSummary({
    unplacedCount: score.unplacedCount,
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

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
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
