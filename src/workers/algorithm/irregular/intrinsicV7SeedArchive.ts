import { Data, Effect } from 'effect'
import { performance } from 'node:perf_hooks'
import type { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import type { IrregularPlacedPiece, IrregularPreparedPiece } from '@shared/irregular/domain.js'
import {
  analyzeCanonicalLayoutStructure,
  canonicalCollisionLayoutIdentity,
  measureCanonicalEnclosedCavities,
  measureCanonicalLayoutContacts,
  measureCanonicalLayoutEnvelope,
  measureCanonicalLayoutTopologyExact,
  placedCollisionWorldGridPath
} from '../../irregular/canonicalLayoutGeometry.js'
import { fromGrid, toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import type { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import type {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError,
  IrregularNfpIfpControl,
  NfpIfpService
} from '../../irregular/services.js'
import { IrregularNfpIfpControlAbortError } from '../../irregular/services.js'
import {
  constructIntrinsicStrictState,
  IntrinsicStrictDecoderError,
  measureIntrinsicSheetlessCompletedLayout,
  type IntrinsicStrictComparatorMode,
  type IntrinsicStrictConstructResult,
  type IntrinsicStrictFeatureContactObserver
} from './intrinsicStrictDecoder.js'
import {
  buildIntrinsicTransformCatalog,
  IntrinsicExactProjectionError,
  type IntrinsicTargetBox,
  type IntrinsicTransformCatalog
} from './intrinsicExactProjection.js'
import {
  createIntrinsicPhaseSignatureMemo,
  evaluateIntrinsicSeparation,
  intrinsicPhaseSignatureCacheStats,
  intrinsicRelaxedStateKey,
  provisionalLayoutFromRelaxedState,
  relaxedStateFromExactLayout,
  transportIntrinsicGroup,
  type IntrinsicPhaseSignatureCacheStats,
  type IntrinsicRelaxedState,
  type IntrinsicSeparationEvaluation
} from './intrinsicTransformSeparator.js'
import { generateIntrinsicTwoRadiusRefinementCandidates } from './intrinsicSqueezeDisruptSeparate.js'

export const INTRINSIC_V7_STAGE1_ARMS = ['control', 'split', 'atomic', 'refine'] as const
export const INTRINSIC_V7_SPLIT_QUANTILES = [1 / 3, 1 / 2, 2 / 3] as const
export const INTRINSIC_V7_MAXIMUM_DIAGNOSTIC_SAMPLES_PER_ARM = 24

export type IntrinsicV7Stage1Arm = (typeof INTRINSIC_V7_STAGE1_ARMS)[number]
export type IntrinsicV7SeedRole = 'canonical-grid' | 'legacy-absolute-envelope'

export const INTRINSIC_V7_SEED_ARCHIVE_DEFAULTS = {
  maximumRuntimeMs: 60_000,
  maximumEvaluations: 12_000,
  infeasiblePoolCapacity: 8,
  legalEndpointCapacity: 8,
  completedSweeps: 2,
  contractionRatios: [1 / 20, 1 / 40, 1 / 80] as const
} as const

export interface IntrinsicV7SeedArchiveSchedule {
  readonly maximumRuntimeMs: number
  readonly maximumEvaluations: number
  readonly infeasiblePoolCapacity: number
  readonly legalEndpointCapacity: number
  readonly completedSweeps: number
  readonly contractionRatios: ReadonlyArray<number>
}

export interface IntrinsicV7SeedRecord {
  readonly role: IntrinsicV7SeedRole
  readonly comparatorMode: IntrinsicStrictComparatorMode
  readonly canonicalGeometryIdentity: string
  readonly canonicalGeometryHash: string
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly stepTrace: IntrinsicStrictConstructResult['stepTrace']
  readonly metrics: NonNullable<ReturnType<typeof measureIntrinsicSheetlessCompletedLayout>>['metrics']
}

export interface IntrinsicV7NumericPressure {
  readonly wallOffenderCount: number
  readonly overlapPairCount: number
  readonly conflictedPieceCount: number
  readonly totalWallOverrunGrid: number
  readonly totalDoubledOverlapAreaGrid2: number
  readonly envelopeAreaGrid2: number
  readonly envelopeMaximumSideGrid: number
  readonly envelopeSpanGrid: number
}

export interface IntrinsicV7LegalEndpointMetric {
  readonly envelopeAreaGrid2: number
  readonly envelopeMaximumSideGrid: number
  readonly enclosedCavityCount: number
  readonly hullGapRatio: number
  readonly hullGapDoubledAreaGrid2: number
  readonly hullDoubledAreaGrid2: number
  readonly isolatedPieceCount: number
  readonly positiveContactComponentCount: number
  readonly largestPositiveContactComponentRatio: number
  readonly dominantContacts: number
  readonly totalContacts: number
  readonly envelopeSpanGrid: number
}

export interface IntrinsicV7Endpoint {
  readonly seedRole: IntrinsicV7SeedRole
  readonly stateKey: string
  readonly terminalIdentity: string
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly metric: IntrinsicV7LegalEndpointMetric
}

export interface IntrinsicV7CandidateCounters {
  readonly generated: number
  readonly materialized: number
  readonly unique: number
  readonly evaluated: number
  readonly canonicalLegal: number
  readonly archiveAdmitted: number
  readonly archiveRejected: number
  readonly archiveEvicted: number
}

export interface IntrinsicV7DiagnosticSample {
  readonly arm: IntrinsicV7Stage1Arm
  readonly seedRole: IntrinsicV7SeedRole
  readonly contractionRatio: number
  readonly kind:
    | 'strict-i-improvement'
    | 'protected-survivor'
    | 'legal-endpoint'
    | 'sat-clipper-disagreement'
  readonly stateKey: string
  readonly numericBefore: IntrinsicV7NumericPressure
  readonly numericAfter: IntrinsicV7NumericPressure
  readonly satRawLoss: number
  readonly satWeightedLoss: number
  readonly canonicalLegal: boolean
  readonly protectedSweepsSurvived: number
  readonly archive:
    | {
        readonly decision:
          | 'admitted'
          | 'admitted-evicted-other'
          | 'already-retained'
          | 'rejected-by-archive'
        readonly evictedCount: number
      }
    | undefined
}

export interface IntrinsicV7ArmTrace {
  readonly arm: IntrinsicV7Stage1Arm
  readonly seedRole: IntrinsicV7SeedRole
  readonly comparatorMode: IntrinsicStrictComparatorMode
  readonly contractionRatio: number
  readonly contractionAxis: 'x' | 'y'
  readonly splitQuantiles: ReadonlyArray<number>
  readonly completedSweeps: number
  readonly counters: IntrinsicV7CandidateCounters
  readonly protection: {
    readonly perFamilyTwoSweepAllowance: true
    readonly finalPoolSize: number
  }
  readonly phaseCache: IntrinsicPhaseSignatureCacheStats
  readonly budget: {
    readonly armEvaluations: number
    readonly maximumEvaluations: number
    readonly elapsedMs: number
    readonly maximumRuntimeMs: number
  }
  readonly elapsedMs: number
}

export interface IntrinsicV7ArmResult {
  readonly arm: IntrinsicV7Stage1Arm
  readonly traces: ReadonlyArray<IntrinsicV7ArmTrace>
  readonly endpointArchive: ReadonlyArray<IntrinsicV7Endpoint>
  readonly diagnosticSamples: ReadonlyArray<IntrinsicV7DiagnosticSample>
}

export interface IntrinsicV7SeedArchiveResult {
  readonly seedArchive: ReadonlyArray<IntrinsicV7SeedRecord>
  readonly armResults: ReadonlyArray<IntrinsicV7ArmResult>
  readonly immutableFallback: IntrinsicV7SeedRecord
  readonly runtimeMs: number
}

/** Optional F0 hook. It observes the two strict seed decodes without entering Stage 1. */
export interface IntrinsicV7FeatureContactObserver {
  readonly onSeedCandidateProvenance: (observation: {
    readonly seedRole: IntrinsicV7SeedRole
    readonly observation: Parameters<IntrinsicStrictFeatureContactObserver['onCandidateProvenance']>[0]
  }) => void
  readonly onSeedStepSelection: (observation: {
    readonly seedRole: IntrinsicV7SeedRole
    readonly observation: Parameters<IntrinsicStrictFeatureContactObserver['onStepSelection']>[0]
  }) => void
}

export class IntrinsicV7SeedArchiveError extends Data.TaggedError(
  'IntrinsicV7SeedArchiveError'
)<{
  readonly operation: 'seed' | 'catalog' | 'state' | 'analysis'
  readonly message: string
}> {}

/**
 * Stage 0/1 experimental controller. It keeps sheet dimensions outside the
 * search: target boxes are private contraction pressure only, while every
 * legal endpoint is admitted through canonical Clipper2 analysis.
 */
export function runIntrinsicV7SeedArchive(input: {
  readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly arms?: ReadonlyArray<IntrinsicV7Stage1Arm>
  readonly schedule?: Partial<IntrinsicV7SeedArchiveSchedule>
  readonly featureContactObserver?: IntrinsicV7FeatureContactObserver
  readonly control?: IrregularNfpIfpControl
}): Effect.Effect<
  IntrinsicV7SeedArchiveResult,
  | IntrinsicV7SeedArchiveError
  | IntrinsicStrictDecoderError
  | IntrinsicExactProjectionError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const schedule = snapshotSchedule(input.schedule)
    const arms = validatedArms(input.arms)
    if (arms.length === 0) {
      return yield* Effect.fail(
        new IntrinsicV7SeedArchiveError({
          operation: 'seed',
          message: 'at least one independent Stage 1 arm is required.'
        })
      )
    }
    const seedArchive = yield* constructDualExactSeeds(
      input.allPreparedPieces,
      input.control,
      input.featureContactObserver
    )
    const catalog = yield* buildIntrinsicTransformCatalog(input.allPreparedPieces)
    const immutableFallback = seedArchive.toSorted(compareSeedRecords)[0]
    if (immutableFallback === undefined) {
      return yield* Effect.fail(
        new IntrinsicV7SeedArchiveError({
          operation: 'seed',
          message: 'the dual exact seed archive was unexpectedly empty.'
        })
      )
    }
    const armResults: IntrinsicV7ArmResult[] = []
    for (const arm of arms) {
      const result = runIndependentStage1Arm({ catalog, seedArchive, arm, schedule })
      armResults.push(result)
    }
    return {
      seedArchive,
      armResults,
      immutableFallback,
      runtimeMs: Math.max(0, performance.now() - startedAt)
    }
  })
}

function snapshotSchedule(
  override: Partial<IntrinsicV7SeedArchiveSchedule> | undefined
): IntrinsicV7SeedArchiveSchedule {
  const schedule = { ...INTRINSIC_V7_SEED_ARCHIVE_DEFAULTS, ...override }
  return {
    maximumRuntimeMs: Math.max(1, Math.floor(schedule.maximumRuntimeMs)),
    maximumEvaluations: Math.max(1, Math.floor(schedule.maximumEvaluations)),
    infeasiblePoolCapacity: Math.max(1, Math.floor(schedule.infeasiblePoolCapacity)),
    legalEndpointCapacity: Math.max(1, Math.floor(schedule.legalEndpointCapacity)),
    completedSweeps: Math.max(1, Math.floor(schedule.completedSweeps)),
    contractionRatios: schedule.contractionRatios
      .filter((ratio) => Number.isFinite(ratio) && ratio > 0 && ratio < 1)
      .toSorted((first, second) => first - second)
  }
}

function validatedArms(
  requested: ReadonlyArray<IntrinsicV7Stage1Arm> | undefined
): ReadonlyArray<IntrinsicV7Stage1Arm> {
  const values = requested ?? INTRINSIC_V7_STAGE1_ARMS
  return [...new Set(values)].filter((arm) => INTRINSIC_V7_STAGE1_ARMS.includes(arm))
}

function constructDualExactSeeds(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  control: IrregularNfpIfpControl | undefined,
  featureContactObserver: IntrinsicV7FeatureContactObserver | undefined
): Effect.Effect<
  ReadonlyArray<IntrinsicV7SeedRecord>,
  | IntrinsicV7SeedArchiveError
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const records: IntrinsicV7SeedRecord[] = []
    for (const seed of [
      { role: 'canonical-grid' as const, comparatorMode: 'pure-growth' as const },
      {
        role: 'legacy-absolute-envelope' as const,
        comparatorMode: 'legacy-absolute-envelope' as const
      }
    ]) {
      const constructed = yield* constructIntrinsicStrictState({
        allPreparedPieces: pieces,
        remainingPreparedPieces: pieces,
        frozenPlaced: [],
        candidateMode: seed.comparatorMode,
        ...(featureContactObserver === undefined
          ? {}
          : {
              featureContactObserver: {
                onCandidateProvenance: (observation) =>
                  featureContactObserver.onSeedCandidateProvenance({
                    seedRole: seed.role,
                    observation
                  }),
                onStepSelection: (observation) =>
                  featureContactObserver.onSeedStepSelection({
                    seedRole: seed.role,
                    observation
                  })
              }
            }),
        ...(control === undefined ? {} : { control })
      })
      const measured = measureIntrinsicSheetlessCompletedLayout(constructed.state, constructed.runtimeMs)
      if (measured === undefined || measured.placedCollisionGeometries.length !== pieces.length) {
        return yield* Effect.fail(
          new IntrinsicV7SeedArchiveError({
            operation: 'seed',
            message: `${seed.role} did not produce a complete canonical-exact seed.`
          })
        )
      }
      records.push({
        role: seed.role,
        comparatorMode: seed.comparatorMode,
        canonicalGeometryIdentity: measured.canonicalGeometryIdentity,
        canonicalGeometryHash: measured.canonicalGeometryHash,
        placedCollisionGeometries: measured.placedCollisionGeometries,
        stepTrace: constructed.stepTrace,
        metrics: measured.metrics
      })
    }
    return records
  })
}

interface InfeasibleEntry {
  readonly state: IntrinsicRelaxedState
  readonly stateKey: string
  readonly evaluation: IntrinsicSeparationEvaluation
  readonly numeric: IntrinsicV7NumericPressure
  readonly lineageUntilSweep: number
}

function runIndependentStage1Arm(input: {
  readonly catalog: IntrinsicTransformCatalog
  readonly seedArchive: ReadonlyArray<IntrinsicV7SeedRecord>
  readonly arm: IntrinsicV7Stage1Arm
  readonly schedule: IntrinsicV7SeedArchiveSchedule
}): IntrinsicV7ArmResult {
  const armStartedAt = performance.now()
  const armBudget: V7ArmBudget = { evaluated: 0 }
  const endpointArchive = new V7EndpointArchive(input.schedule.legalEndpointCapacity)
  const samples = new BoundedV7Samples()
  const traces: IntrinsicV7ArmTrace[] = []
  for (const seed of input.seedArchive) {
    const seedState = relaxedStateFromExactLayout(input.catalog, seed.placedCollisionGeometries)
    const seedBox = intrinsicTargetFromPlaced(seed.placedCollisionGeometries)
    if (seedState === undefined || seedBox === undefined) continue
    const seedPhaseMemo = createIntrinsicPhaseSignatureMemo()
    const seedStateKey = intrinsicRelaxedStateKey(input.catalog, seedState, seedPhaseMemo)
    const seedEndpoint =
      seedStateKey === undefined
        ? undefined
        : makeV7LegalEndpoint(seed.role, seedStateKey, seed.placedCollisionGeometries)
    if (seedEndpoint !== undefined) endpointArchive.add(seedEndpoint)
    for (const contractionRatio of input.schedule.contractionRatios) {
      if (performance.now() - armStartedAt >= input.schedule.maximumRuntimeMs) break
      const phaseMemo = createIntrinsicPhaseSignatureMemo()
      const seenStateKeys = new Set<string>()
      const contracted = splitContractedState(input.catalog, seedState, seedBox, contractionRatio, 0.5)
      if (contracted === undefined) continue
      let counters: MutableCounters = zeroCounters()
      const initialStates =
        input.arm === 'split'
          ? INTRINSIC_V7_SPLIT_QUANTILES
              .map((quantile) =>
                splitContractedState(
                  input.catalog,
                  seedState,
                  seedBox,
                  contractionRatio,
                  quantile
                )
              )
              .filter(
                (candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined
              )
          : [contracted]
      let pool: ReadonlyArray<InfeasibleEntry> = initialStates.flatMap((initial) => {
        if (armBudget.evaluated >= input.schedule.maximumEvaluations) return []
        const entry = evaluateAndRecord({
          catalog: input.catalog,
          seedRole: seed.role,
          targetBox: initial.targetBox,
          state: initial.state,
          phaseMemo,
          counters,
          endpointArchive,
          samples,
          seenStateKeys,
          armBudget,
          arm: input.arm,
          contractionRatio,
          numericBefore: undefined,
          lineageUntilSweep: 2
        })
        return entry === undefined ? [] : [entry]
      })
      if (pool.length === 0) continue
      let completedSweepCount = 0
      for (let sweep = 0; sweep < input.schedule.completedSweeps; sweep += 1) {
        if (performance.now() - armStartedAt >= input.schedule.maximumRuntimeMs) break
        const children: InfeasibleEntry[] = [...pool]
        let sweepInterrupted = false
        for (const parent of pool) {
          if (performance.now() - armStartedAt >= input.schedule.maximumRuntimeMs) {
            sweepInterrupted = true
            break
          }
          if (armBudget.evaluated >= input.schedule.maximumEvaluations) {
            sweepInterrupted = true
            break
          }
          const states = generateArmStates({
            arm: input.arm,
            catalog: input.catalog,
            state: parent.state,
            targetBox: contracted.targetBox,
            evaluation: parent.evaluation
          })
          counters.generated += states.length
          for (const state of states) {
            if (performance.now() - armStartedAt >= input.schedule.maximumRuntimeMs) {
              sweepInterrupted = true
              break
            }
            if (armBudget.evaluated >= input.schedule.maximumEvaluations) {
              sweepInterrupted = true
              break
            }
            const child = evaluateAndRecord({
              catalog: input.catalog,
              seedRole: seed.role,
              targetBox: contracted.targetBox,
              state,
              phaseMemo,
              counters,
              endpointArchive,
              samples,
              seenStateKeys,
              armBudget,
              arm: input.arm,
              contractionRatio,
              numericBefore: parent.numeric,
              lineageUntilSweep: parent.lineageUntilSweep > 0 ? parent.lineageUntilSweep - 1 : 0
            })
            if (child !== undefined) children.push(child)
          }
          if (sweepInterrupted) break
        }
        if (sweepInterrupted) break
        pool = retainV7InfeasiblePool(children, input.schedule.infeasiblePoolCapacity)
        completedSweepCount += 1
        const protectedSurvivor = pool.find(({ lineageUntilSweep }) => lineageUntilSweep > 0)
        if (protectedSurvivor !== undefined) {
          samples.add({
            arm: input.arm,
            seedRole: seed.role,
            contractionRatio,
            kind: 'protected-survivor',
            stateKey: protectedSurvivor.stateKey,
            numericBefore: protectedSurvivor.numeric,
            numericAfter: protectedSurvivor.numeric,
            satRawLoss: protectedSurvivor.evaluation.rawLoss,
            satWeightedLoss: protectedSurvivor.evaluation.weightedLoss,
            canonicalLegal: false,
            protectedSweepsSurvived: completedSweepCount,
            archive: undefined
          })
        }
      }
      traces.push({
        arm: input.arm,
        seedRole: seed.role,
        comparatorMode: seed.comparatorMode,
        contractionRatio,
        contractionAxis: contracted.axis,
        splitQuantiles: input.arm === 'split' ? INTRINSIC_V7_SPLIT_QUANTILES : [],
        completedSweeps: completedSweepCount,
        counters: freezeCounters(counters),
        protection: {
          perFamilyTwoSweepAllowance: true,
          finalPoolSize: pool.length
        },
        phaseCache: intrinsicPhaseSignatureCacheStats(phaseMemo),
        budget: {
          armEvaluations: armBudget.evaluated,
          maximumEvaluations: input.schedule.maximumEvaluations,
          elapsedMs: Math.max(0, performance.now() - armStartedAt),
          maximumRuntimeMs: input.schedule.maximumRuntimeMs
        },
        elapsedMs: Math.max(0, performance.now() - armStartedAt)
      })
    }
  }
  return {
    arm: input.arm,
    traces,
    endpointArchive: endpointArchive.values(),
    diagnosticSamples: samples.values()
  }
}

interface MutableCounters {
  generated: number
  materialized: number
  unique: number
  evaluated: number
  canonicalLegal: number
  archiveAdmitted: number
  archiveRejected: number
  archiveEvicted: number
}

interface V7ArmBudget {
  evaluated: number
}

function zeroCounters(): MutableCounters {
  return {
    generated: 0,
    materialized: 0,
    unique: 0,
    evaluated: 0,
    canonicalLegal: 0,
    archiveAdmitted: 0,
    archiveRejected: 0,
    archiveEvicted: 0
  }
}

function freezeCounters(counters: MutableCounters): IntrinsicV7CandidateCounters {
  return { ...counters }
}

function evaluateAndRecord(input: {
  readonly catalog: IntrinsicTransformCatalog
  readonly seedRole: IntrinsicV7SeedRole
  readonly targetBox: IntrinsicTargetBox
  readonly state: IntrinsicRelaxedState
  readonly phaseMemo: ReturnType<typeof createIntrinsicPhaseSignatureMemo>
  readonly counters: MutableCounters
  readonly endpointArchive: V7EndpointArchive
  readonly samples: BoundedV7Samples
  readonly seenStateKeys: Set<string>
  readonly armBudget: V7ArmBudget
  readonly arm: IntrinsicV7Stage1Arm
  readonly contractionRatio: number
  readonly numericBefore: IntrinsicV7NumericPressure | undefined
  readonly lineageUntilSweep: number
}): InfeasibleEntry | undefined {
  const stateKey = intrinsicRelaxedStateKey(input.catalog, input.state, input.phaseMemo)
  if (stateKey === undefined) return undefined
  input.counters.materialized += 1
  if (input.seenStateKeys.has(stateKey)) return undefined
  input.seenStateKeys.add(stateKey)
  input.counters.unique += 1
  const evaluation = evaluateIntrinsicSeparation(input.targetBox, input.catalog, input.state)
  const placed = provisionalLayoutFromRelaxedState(input.catalog, input.state)
  if (evaluation === undefined || placed === undefined) return undefined
  const numeric = measureIntrinsicV7NumericPressure(input.targetBox, placed)
  if (numeric === undefined) return undefined
  input.counters.evaluated += 1
  input.armBudget.evaluated += 1
  const canonicalLegal = isNumericPressureLegal(numeric)
  const disagreement = canonicalLegal !== evaluation.exactZeroLoss
  if (disagreement) {
    input.samples.add({
      arm: input.arm,
      seedRole: input.seedRole,
      contractionRatio: input.contractionRatio,
      kind: 'sat-clipper-disagreement',
      stateKey,
      numericBefore: input.numericBefore ?? numeric,
      numericAfter: numeric,
      satRawLoss: evaluation.rawLoss,
      satWeightedLoss: evaluation.weightedLoss,
      canonicalLegal,
      protectedSweepsSurvived: 0,
      archive: undefined
    })
  }
  if (input.numericBefore !== undefined && compareNumericPressure(numeric, input.numericBefore) < 0) {
    input.samples.add({
      arm: input.arm,
      seedRole: input.seedRole,
      contractionRatio: input.contractionRatio,
      kind: 'strict-i-improvement',
      stateKey,
      numericBefore: input.numericBefore,
      numericAfter: numeric,
      satRawLoss: evaluation.rawLoss,
      satWeightedLoss: evaluation.weightedLoss,
      canonicalLegal,
      protectedSweepsSurvived: 0,
      archive: undefined
    })
  }
  if (canonicalLegal) {
    input.counters.canonicalLegal += 1
    const endpoint = makeV7LegalEndpoint(input.seedRole, stateKey, placed)
    if (endpoint === undefined) {
      input.counters.archiveRejected += 1
      return undefined
    }
    const admission = input.endpointArchive.add(endpoint)
    if (admission.admitted) input.counters.archiveAdmitted += 1
    if (!admission.admitted) input.counters.archiveRejected += 1
    input.counters.archiveEvicted += admission.evictedCount
    input.samples.add({
      arm: input.arm,
      seedRole: input.seedRole,
      contractionRatio: input.contractionRatio,
      kind: 'legal-endpoint',
      stateKey,
      numericBefore: input.numericBefore ?? numeric,
      numericAfter: numeric,
      satRawLoss: evaluation.rawLoss,
      satWeightedLoss: evaluation.weightedLoss,
      canonicalLegal: true,
      protectedSweepsSurvived: 0,
      archive: {
        decision: admission.decision,
        evictedCount: admission.evictedCount
      }
    })
    // Legal endpoints are archive-only. They must not consume the infeasible pool.
    return undefined
  }
  return {
    state: input.state,
    stateKey,
    evaluation,
    numeric,
    lineageUntilSweep: input.lineageUntilSweep
  }
}

function retainV7InfeasiblePool(
  candidates: ReadonlyArray<InfeasibleEntry>,
  capacity: number
): ReadonlyArray<InfeasibleEntry> {
  const unique = new Map<string, InfeasibleEntry>()
  for (const candidate of candidates) {
    const current = unique.get(candidate.stateKey)
    if (current === undefined || compareV7InfeasibleEntries(candidate, current) < 0) {
      unique.set(candidate.stateKey, candidate)
    }
  }
  const ranked = [...unique.values()].toSorted(compareV7InfeasibleEntries)
  const protectedLineage = ranked.find(({ lineageUntilSweep }) => lineageUntilSweep > 0)
  const result = protectedLineage === undefined ? [] : [protectedLineage]
  for (const candidate of ranked) {
    if (result.length >= capacity) break
    if (candidate.stateKey !== protectedLineage?.stateKey) result.push(candidate)
  }
  return result
}

function compareV7InfeasibleEntries(first: InfeasibleEntry, second: InfeasibleEntry): number {
  return (
    compareNumericPressure(first.numeric, second.numeric) ||
    first.evaluation.rawLoss - second.evaluation.rawLoss ||
    first.evaluation.weightedLoss - second.evaluation.weightedLoss ||
    first.stateKey.localeCompare(second.stateKey)
  )
}

function compareNumericPressure(
  first: IntrinsicV7NumericPressure,
  second: IntrinsicV7NumericPressure
): number {
  return (
    first.wallOffenderCount - second.wallOffenderCount ||
    first.overlapPairCount - second.overlapPairCount ||
    first.conflictedPieceCount - second.conflictedPieceCount ||
    first.totalWallOverrunGrid - second.totalWallOverrunGrid ||
    first.totalDoubledOverlapAreaGrid2 - second.totalDoubledOverlapAreaGrid2 ||
    first.envelopeAreaGrid2 - second.envelopeAreaGrid2 ||
    first.envelopeMaximumSideGrid - second.envelopeMaximumSideGrid ||
    first.envelopeSpanGrid - second.envelopeSpanGrid
  )
}

function isNumericPressureLegal(numeric: IntrinsicV7NumericPressure): boolean {
  return (
    numeric.wallOffenderCount === 0 &&
    numeric.overlapPairCount === 0 &&
    numeric.conflictedPieceCount === 0 &&
    numeric.totalWallOverrunGrid === 0 &&
    numeric.totalDoubledOverlapAreaGrid2 === 0
  )
}

/** Exact canonical Clipper2 pressure tuple at a target whose dimensions are on the collision grid. */
export function measureIntrinsicV7NumericPressure(
  targetBox: IntrinsicTargetBox,
  placed: ReadonlyArray<IrregularPlacedPiece>
): IntrinsicV7NumericPressure | undefined {
  const widthGrid = toGridMm(targetBox.widthMm)
  const heightGrid = toGridMm(targetBox.heightMm)
  if (widthGrid === undefined || heightGrid === undefined || widthGrid <= 0 || heightGrid <= 0) {
    return undefined
  }
  // SheetSpec is integer-millimetre only. It is used here solely to obtain
  // Clipper pair intersections; exact wall admission stays on target grid.
  const target = new SheetSpec({
    width: Math.max(1, Math.ceil(fromGrid(widthGrid))),
    height: Math.max(1, Math.ceil(fromGrid(heightGrid))),
    label: 'intrinsic-v7-clipper-pair-analysis'
  })
  const structure = analyzeCanonicalLayoutStructure(target, placed)
  const envelope = measureCanonicalLayoutEnvelope(placed)
  if (structure === undefined || envelope === undefined) return undefined
  const exactWallOffenders = structure.pieces
    .filter(
      ({ aabb }) =>
        aabb.minX < 0 ||
        aabb.minY < 0 ||
        aabb.maxX > widthGrid ||
        aabb.maxY > heightGrid
    )
    .map(({ pieceId }) => pieceId)
  const conflicted = new Set<PieceId>(exactWallOffenders)
  for (const [first, second] of structure.positiveAreaConflicts) {
    conflicted.add(first)
    conflicted.add(second)
  }
  const overrun = structure.pieces.reduce((total, piece) => {
    const { aabb } = piece
    return (
      total +
      Math.max(0, -aabb.minX) +
      Math.max(0, -aabb.minY) +
      Math.max(0, aabb.maxX - widthGrid) +
      Math.max(0, aabb.maxY - heightGrid)
    )
  }, 0)
  const doubledOverlap = structure.positiveAreaConflictMeasurements.reduce(
    (total, { areaMm2 }) => total + Math.round(areaMm2 * 2_000_000),
    0
  )
  const areaGrid2 = Math.round(envelope.areaMm2 * 1_000_000)
  const maxGrid = Math.round(envelope.maximumSideMm * 1_000)
  const spanGrid = Math.round(envelope.spanMm * 1_000)
  return [overrun, doubledOverlap, areaGrid2, maxGrid, spanGrid].every(Number.isFinite)
    ? {
        wallOffenderCount: exactWallOffenders.length,
        overlapPairCount: structure.positiveAreaConflicts.length,
        conflictedPieceCount: conflicted.size,
        totalWallOverrunGrid: overrun,
        totalDoubledOverlapAreaGrid2: doubledOverlap,
        envelopeAreaGrid2: areaGrid2,
        envelopeMaximumSideGrid: maxGrid,
        envelopeSpanGrid: spanGrid
      }
    : undefined
}

function makeV7LegalEndpoint(
  seedRole: IntrinsicV7SeedRole,
  stateKey: string,
  placed: ReadonlyArray<IrregularPlacedPiece>
): IntrinsicV7Endpoint | undefined {
  const terminalIdentity = canonicalCollisionLayoutIdentity(placed)
  const envelope = measureCanonicalLayoutEnvelope(placed)
  const cavities = measureCanonicalEnclosedCavities(placed)
  const topologyExact = measureCanonicalLayoutTopologyExact(placed)
  const contacts = measureCanonicalLayoutContacts(placed)
  if (
    terminalIdentity === undefined ||
    envelope === undefined ||
    cavities === undefined ||
    topologyExact === undefined ||
    contacts === undefined
  ) {
    return undefined
  }
  return {
    seedRole,
    stateKey,
    terminalIdentity,
    placedCollisionGeometries: placed,
    metric: {
      envelopeAreaGrid2: Math.round(envelope.areaMm2 * 1_000_000),
      envelopeMaximumSideGrid: Math.round(envelope.maximumSideMm * 1_000),
      enclosedCavityCount: cavities.count,
      hullGapRatio: topologyExact.topology.largestOccupiedHullGapRatio,
      hullGapDoubledAreaGrid2: topologyExact.hullGapDoubledAreaGrid2,
      hullDoubledAreaGrid2: topologyExact.hullDoubledAreaGrid2,
      isolatedPieceCount: topologyExact.topology.isolatedPieceCount,
      positiveContactComponentCount: topologyExact.topology.positiveContactComponentCount,
      largestPositiveContactComponentRatio:
        topologyExact.topology.largestPositiveContactComponentRatio,
      dominantContacts: contacts.dominantStructuralContacts,
      totalContacts: contacts.totalStructuralContacts,
      envelopeSpanGrid: Math.round(envelope.spanMm * 1_000)
    }
  }
}

/** Bounded legal archive: seed area and topology representatives plus alternating P/frontier slots. */
export function retainV7LegalEndpointArchive(
  candidates: ReadonlyArray<IntrinsicV7Endpoint>,
  capacity: number = INTRINSIC_V7_SEED_ARCHIVE_DEFAULTS.legalEndpointCapacity
): ReadonlyArray<IntrinsicV7Endpoint> {
  const unique = new Map<string, IntrinsicV7Endpoint>()
  for (const candidate of candidates) {
    const current = unique.get(candidate.stateKey)
    if (current === undefined || compareV7Area(candidate, current) < 0) unique.set(candidate.stateKey, candidate)
  }
  const all = [...unique.values()]
  const selected: IntrinsicV7Endpoint[] = []
  for (const role of ['canonical-grid', 'legacy-absolute-envelope'] as const) {
    const fromRole = all.filter(({ seedRole }) => seedRole === role)
    addEndpointOnce(selected, fromRole.toSorted(compareV7Area)[0])
    addEndpointOnce(selected, fromRole.toSorted(compareV7Topology)[0])
  }
  const frontier = all.filter((candidate) =>
    !all.some((other) => other.stateKey !== candidate.stateKey && dominatesV7P(other, candidate))
  )
  const pSorted = frontier.toSorted(compareV7P)
  const topologySorted = frontier.toSorted(compareV7Topology)
  let pIndex = 0
  let topologyIndex = 0
  while (
    selected.length < capacity &&
    (pIndex < pSorted.length || topologyIndex < topologySorted.length)
  ) {
    const preferP = selected.length % 2 === 0
    const next = preferP
      ? pSorted[pIndex++] ?? topologySorted[topologyIndex++]
      : topologySorted[topologyIndex++] ?? pSorted[pIndex++]
    if (next !== undefined) addEndpointOnce(selected, next)
  }
  return selected.slice(0, Math.max(0, capacity))
}

class V7EndpointArchive {
  private entries: ReadonlyArray<IntrinsicV7Endpoint> = []

  constructor(private readonly capacity: number) {}

  add(candidate: IntrinsicV7Endpoint): {
    readonly admitted: boolean
    readonly evictedCount: number
    readonly decision:
      | 'admitted'
      | 'admitted-evicted-other'
      | 'already-retained'
      | 'rejected-by-archive'
  } {
    const before = new Set(this.entries.map(({ stateKey }) => stateKey))
    const ranked = retainV7LegalEndpointArchive([...this.entries, candidate], this.capacity)
    const after = new Set(ranked.map(({ stateKey }) => stateKey))
    this.entries = ranked
    const evictedCount = [...before].filter((stateKey) => !after.has(stateKey)).length
    const admitted = after.has(candidate.stateKey)
    return {
      admitted,
      evictedCount,
      decision: before.has(candidate.stateKey)
        ? 'already-retained'
        : !admitted
          ? 'rejected-by-archive'
          : evictedCount > 0
            ? 'admitted-evicted-other'
            : 'admitted'
    }
  }

  values(): ReadonlyArray<IntrinsicV7Endpoint> {
    return this.entries
  }
}

function addEndpointOnce(
  target: IntrinsicV7Endpoint[],
  candidate: IntrinsicV7Endpoint | undefined
): void {
  if (candidate !== undefined && !target.some(({ stateKey }) => stateKey === candidate.stateKey)) {
    target.push(candidate)
  }
}

function compareV7Area(first: IntrinsicV7Endpoint, second: IntrinsicV7Endpoint): number {
  return (
    first.metric.envelopeAreaGrid2 - second.metric.envelopeAreaGrid2 ||
    first.metric.envelopeMaximumSideGrid - second.metric.envelopeMaximumSideGrid ||
    first.stateKey.localeCompare(second.stateKey)
  )
}

function compareV7Topology(first: IntrinsicV7Endpoint, second: IntrinsicV7Endpoint): number {
  return (
    first.metric.enclosedCavityCount - second.metric.enclosedCavityCount ||
    first.metric.isolatedPieceCount - second.metric.isolatedPieceCount ||
    first.metric.positiveContactComponentCount - second.metric.positiveContactComponentCount ||
    second.metric.largestPositiveContactComponentRatio - first.metric.largestPositiveContactComponentRatio ||
    compareHullGapRatio(first.metric, second.metric) ||
    first.metric.envelopeAreaGrid2 - second.metric.envelopeAreaGrid2 ||
    first.metric.envelopeMaximumSideGrid - second.metric.envelopeMaximumSideGrid ||
    first.metric.envelopeSpanGrid - second.metric.envelopeSpanGrid ||
    second.metric.dominantContacts - first.metric.dominantContacts ||
    second.metric.totalContacts - first.metric.totalContacts ||
    first.stateKey.localeCompare(second.stateKey)
  )
}

function compareV7P(first: IntrinsicV7Endpoint, second: IntrinsicV7Endpoint): number {
  return (
    first.metric.envelopeAreaGrid2 - second.metric.envelopeAreaGrid2 ||
    first.metric.envelopeMaximumSideGrid - second.metric.envelopeMaximumSideGrid ||
    first.metric.enclosedCavityCount - second.metric.enclosedCavityCount ||
    compareHullGapRatio(first.metric, second.metric) ||
    first.metric.isolatedPieceCount - second.metric.isolatedPieceCount ||
    first.metric.positiveContactComponentCount - second.metric.positiveContactComponentCount ||
    second.metric.largestPositiveContactComponentRatio - first.metric.largestPositiveContactComponentRatio ||
    second.metric.dominantContacts - first.metric.dominantContacts ||
    second.metric.totalContacts - first.metric.totalContacts ||
    first.stateKey.localeCompare(second.stateKey)
  )
}

function dominatesV7P(first: IntrinsicV7Endpoint, second: IntrinsicV7Endpoint): boolean {
  const firstMetric = first.metric
  const secondMetric = second.metric
  const noWorse =
    firstMetric.envelopeAreaGrid2 <= secondMetric.envelopeAreaGrid2 &&
    firstMetric.envelopeMaximumSideGrid <= secondMetric.envelopeMaximumSideGrid &&
    firstMetric.enclosedCavityCount <= secondMetric.enclosedCavityCount &&
    compareHullGapRatio(firstMetric, secondMetric) <= 0 &&
    firstMetric.isolatedPieceCount <= secondMetric.isolatedPieceCount &&
    firstMetric.positiveContactComponentCount <= secondMetric.positiveContactComponentCount &&
    firstMetric.largestPositiveContactComponentRatio >= secondMetric.largestPositiveContactComponentRatio &&
    firstMetric.dominantContacts >= secondMetric.dominantContacts &&
    firstMetric.totalContacts >= secondMetric.totalContacts
  const strictlyBetter =
    firstMetric.envelopeAreaGrid2 < secondMetric.envelopeAreaGrid2 ||
    firstMetric.envelopeMaximumSideGrid < secondMetric.envelopeMaximumSideGrid ||
    firstMetric.enclosedCavityCount < secondMetric.enclosedCavityCount ||
    compareHullGapRatio(firstMetric, secondMetric) < 0 ||
    firstMetric.isolatedPieceCount < secondMetric.isolatedPieceCount ||
    firstMetric.positiveContactComponentCount < secondMetric.positiveContactComponentCount ||
    firstMetric.largestPositiveContactComponentRatio >
      secondMetric.largestPositiveContactComponentRatio ||
    firstMetric.dominantContacts > secondMetric.dominantContacts ||
    firstMetric.totalContacts > secondMetric.totalContacts
  return noWorse && strictlyBetter
}

function compareHullGapRatio(
  first: Pick<
    IntrinsicV7LegalEndpointMetric,
    'hullGapDoubledAreaGrid2' | 'hullDoubledAreaGrid2'
  >,
  second: Pick<
    IntrinsicV7LegalEndpointMetric,
    'hullGapDoubledAreaGrid2' | 'hullDoubledAreaGrid2'
  >
): number {
  const firstNumerator = BigInt(first.hullGapDoubledAreaGrid2)
  const secondNumerator = BigInt(second.hullGapDoubledAreaGrid2)
  const firstDenominator = BigInt(Math.max(1, first.hullDoubledAreaGrid2))
  const secondDenominator = BigInt(Math.max(1, second.hullDoubledAreaGrid2))
  const left = firstNumerator * secondDenominator
  const right = secondNumerator * firstDenominator
  return left < right ? -1 : left > right ? 1 : 0
}

function splitContractedState(
  catalog: IntrinsicTransformCatalog,
  state: IntrinsicRelaxedState,
  box: IntrinsicTargetBox,
  contractionRatio: number,
  quantile: number
): { readonly state: IntrinsicRelaxedState; readonly targetBox: IntrinsicTargetBox; readonly axis: 'x' | 'y' } | undefined {
  const placed = provisionalLayoutFromRelaxedState(catalog, state)
  const bounds = placed === undefined ? undefined : intrinsicTargetFromPlaced(placed)
  if (placed === undefined || bounds === undefined) return undefined
  const widthGrid = toGridMm(bounds.widthMm)
  const heightGrid = toGridMm(bounds.heightMm)
  if (widthGrid === undefined || heightGrid === undefined) return undefined
  const axis = widthGrid >= heightGrid ? 'x' : 'y'
  const span = axis === 'x' ? widthGrid : heightGrid
  const removed = Math.max(1, Math.floor(span * contractionRatio))
  const nextSpan = span - removed
  if (nextSpan <= 0) return undefined
  const coordinates = placed
    .map((entry) => {
      const path = placedCollisionWorldGridPath(entry)
      if (path === undefined || path.length === 0) return undefined
      const coordinate =
        axis === 'x'
          ? Math.min(...path.map(({ x }) => x))
          : Math.min(...path.map(({ y }) => y))
      const pieceId = entry.placement.pieceId ?? entry.placement.sourcePieceId
      return { pieceId, coordinate }
    })
    .filter(
      (entry): entry is { readonly pieceId: PieceId; readonly coordinate: number } =>
        entry !== undefined
    )
    .toSorted(
      (first, second) =>
        first.coordinate - second.coordinate || first.pieceId.localeCompare(second.pieceId)
    )
  if (coordinates.length !== state.poses.length) return undefined
  const minimum = coordinates[0]?.coordinate
  if (minimum === undefined) return undefined
  const cutoff = minimum + Math.round(span * quantile)
  const far = coordinates.filter(({ coordinate }) => coordinate >= cutoff).map(({ pieceId }) => pieceId)
  if (far.length === 0 || far.length === state.poses.length) return undefined
  const translated = transportIntrinsicGroup(
    catalog,
    state,
    far,
    axis === 'x' ? { x: -removed, y: 0 } : { x: 0, y: -removed }
  )
  return translated === undefined
    ? undefined
    : {
        state: translated,
        targetBox:
          axis === 'x'
            ? { widthMm: fromGrid(nextSpan), heightMm: box.heightMm }
            : { widthMm: box.widthMm, heightMm: fromGrid(nextSpan) },
        axis
      }
}

function generateArmStates(input: {
  readonly arm: IntrinsicV7Stage1Arm
  readonly catalog: IntrinsicTransformCatalog
  readonly state: IntrinsicRelaxedState
  readonly targetBox: IntrinsicTargetBox
  readonly evaluation: IntrinsicSeparationEvaluation
}): ReadonlyArray<IntrinsicRelaxedState> {
  switch (input.arm) {
    case 'control':
      return []
    case 'split':
      return []
    case 'atomic':
      return generateAtomicCanonicalPairStates(input)
    case 'refine':
      return generateStandaloneRefinementStates(input)
  }
}

function generateAtomicCanonicalPairStates(input: {
  readonly catalog: IntrinsicTransformCatalog
  readonly state: IntrinsicRelaxedState
  readonly targetBox: IntrinsicTargetBox
  readonly evaluation: IntrinsicSeparationEvaluation
}): ReadonlyArray<IntrinsicRelaxedState> {
  const placed = provisionalLayoutFromRelaxedState(input.catalog, input.state)
  if (placed === undefined) return []
  const target = new SheetSpec({
    width: Math.max(1, Math.ceil(input.targetBox.widthMm)),
    height: Math.max(1, Math.ceil(input.targetBox.heightMm)),
    label: 'intrinsic-v7-atomic-pair'
  })
  const structure = analyzeCanonicalLayoutStructure(target, placed)
  const strongest = structure?.positiveAreaConflictMeasurements.toSorted(
    (first, second) =>
      second.areaMm2 - first.areaMm2 ||
      first.pair[0].localeCompare(second.pair[0]) ||
      first.pair[1].localeCompare(second.pair[1])
  )[0]
  if (strongest === undefined) return []
  const [firstPieceId, secondPieceId] = strongest.pair
  const sat = input.evaluation.conflicts.find(
    (conflict) =>
      conflict.kind === 'pair' &&
      ((conflict.firstPieceId === firstPieceId && conflict.secondPieceId === secondPieceId) ||
        (conflict.firstPieceId === secondPieceId && conflict.secondPieceId === firstPieceId))
  )
  if (sat === undefined) return []
  const orientation =
    sat.firstPieceId === firstPieceId && sat.secondPieceId === secondPieceId ? 1 : -1
  const relativeX = orientation * sat.moveXGrid
  const relativeY = orientation * sat.moveYGrid
  const xAllocations = intrinsicV7BalancedAtomicAllocations(relativeX)
  const yAllocations = intrinsicV7BalancedAtomicAllocations(relativeY)
  const unique = new Map<string, IntrinsicRelaxedState>()
  for (const firstX of xAllocations) {
    for (const firstY of yAllocations) {
      const firstMoved = transportIntrinsicGroup(input.catalog, input.state, [firstPieceId], {
        x: firstX,
        y: firstY
      })
      const complete =
        firstMoved === undefined
          ? undefined
          : transportIntrinsicGroup(input.catalog, firstMoved, [secondPieceId], {
              x: firstX - relativeX,
              y: firstY - relativeY
            })
      const key = complete === undefined ? undefined : intrinsicRelaxedStateKey(input.catalog, complete)
      if (complete !== undefined && key !== undefined) unique.set(key, complete)
    }
  }
  return [...unique.values()]
}

export function intrinsicV7BalancedAtomicAllocations(
  relativeDelta: number
): ReadonlyArray<number> {
  const floor = Math.floor(relativeDelta / 2)
  const ceil = Math.ceil(relativeDelta / 2)
  return floor === ceil ? [floor] : [floor, ceil]
}

function generateStandaloneRefinementStates(input: {
  readonly catalog: IntrinsicTransformCatalog
  readonly state: IntrinsicRelaxedState
  readonly targetBox: IntrinsicTargetBox
  readonly evaluation: IntrinsicSeparationEvaluation
}): ReadonlyArray<IntrinsicRelaxedState> {
  const selectedPieceId = input.evaluation.conflicts.toSorted(
    (first, second) =>
      second.normalizedDepth - first.normalizedDepth || first.key.localeCompare(second.key)
  )[0]?.firstPieceId
  if (selectedPieceId === undefined) return []
  return (
    generateIntrinsicTwoRadiusRefinementCandidates({
      targetBox: input.targetBox,
      catalog: input.catalog,
      seedState: input.state,
      selectedPieceId
    })?.candidates.map(({ state }) => state) ?? []
  )
}

function intrinsicTargetFromPlaced(
  placed: ReadonlyArray<IrregularPlacedPiece>
): IntrinsicTargetBox | undefined {
  const paths = placed.map(placedCollisionWorldGridPath)
  if (paths.some((path) => path === undefined)) return undefined
  const points = paths.flatMap((path) => path ?? [])
  if (points.length === 0) return undefined
  const minX = Math.min(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y))
  const maxX = Math.max(...points.map(({ x }) => x))
  const maxY = Math.max(...points.map(({ y }) => y))
  const widthGrid = maxX - minX
  const heightGrid = maxY - minY
  return widthGrid > 0 && heightGrid > 0
    ? { widthMm: fromGrid(widthGrid), heightMm: fromGrid(heightGrid) }
    : undefined
}

function compareSeedRecords(first: IntrinsicV7SeedRecord, second: IntrinsicV7SeedRecord): number {
  return (
    first.metrics.envelopeAreaMm2 - second.metrics.envelopeAreaMm2 ||
    first.metrics.envelopeMaximumSideMm - second.metrics.envelopeMaximumSideMm ||
    first.metrics.enclosedCavityCount - second.metrics.enclosedCavityCount ||
    first.role.localeCompare(second.role)
  )
}

class BoundedV7Samples {
  private readonly byTuple = new Map<string, Map<IntrinsicV7DiagnosticSample['kind'], IntrinsicV7DiagnosticSample>>()

  add(sample: IntrinsicV7DiagnosticSample): void {
    const tuple = `${sample.arm}:${sample.seedRole}:${sample.contractionRatio}`
    const samples = this.byTuple.get(tuple) ?? new Map()
    const current = samples.get(sample.kind)
    if (current === undefined || compareV7Samples(sample, current) < 0) {
      samples.set(sample.kind, sample)
    }
    this.byTuple.set(tuple, samples)
  }

  values(): ReadonlyArray<IntrinsicV7DiagnosticSample> {
    return [...this.byTuple.values()]
      .flatMap((samples) => [...samples.values()])
      .toSorted(
        (first, second) =>
          first.arm.localeCompare(second.arm) ||
          first.seedRole.localeCompare(second.seedRole) ||
          first.contractionRatio - second.contractionRatio ||
          first.kind.localeCompare(second.kind) ||
          first.stateKey.localeCompare(second.stateKey)
      )
  }
}

function compareV7Samples(
  first: IntrinsicV7DiagnosticSample,
  second: IntrinsicV7DiagnosticSample
): number {
  if (first.kind === 'sat-clipper-disagreement') return 1
  if (first.kind === 'protected-survivor') {
    return (
      second.protectedSweepsSurvived - first.protectedSweepsSurvived ||
      compareNumericPressure(first.numericAfter, second.numericAfter) ||
      first.stateKey.localeCompare(second.stateKey)
    )
  }
  return (
    compareNumericPressure(first.numericAfter, second.numericAfter) ||
    first.satRawLoss - second.satRawLoss ||
    first.satWeightedLoss - second.satWeightedLoss ||
    first.stateKey.localeCompare(second.stateKey)
  )
}
