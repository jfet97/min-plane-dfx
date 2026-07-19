import { Data, Effect } from 'effect'
import { performance } from 'node:perf_hooks'
import type { PieceId } from '@shared/domain/ids.js'
import type { IrregularPlacedPiece, IrregularPreparedPiece } from '@shared/irregular/domain.js'
import type { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
  type IrregularNfpIfpControl,
  IrregularNfpIfpControlAbortError,
  IrregularNestingNotImplementedError,
  type NfpIfpService
} from '../../irregular/services.js'
import { IrregularBeamState } from './irregularBeamState.js'
import {
  constructIntrinsicStrictState,
  IntrinsicStrictDecoderError,
  measureIntrinsicSheetlessCompletedLayout,
  type ConstructIntrinsicStrictStateInput,
  type IntrinsicSheetlessCompletedLayout,
  type IntrinsicStrictConstructResult
} from './intrinsicStrictDecoder.js'
import {
  partitionIntrinsicStructuralPieces,
  runIntrinsicSqueezeDisruptSeparate,
  IntrinsicGlobalSearchError,
  type IntrinsicGlobalSearchResult,
  type IntrinsicProjectionAttemptTrace,
  type IntrinsicStructuralHandoff
} from './intrinsicSqueezeDisruptSeparate.js'
import type { IntrinsicExactProjectionError } from './intrinsicExactProjection.js'

export const INTRINSIC_GLOBAL_PORTFOLIO_DEFAULTS = {
  maximumRuntimeMs: 110_000,
  completeArchiveCapacity: 6,
  maximumCavityCount: 2,
  maximumLargestHullGapRatio: 0.15,
  explorationAreaCapMm2: 439_904.17,
  productionAreaTargetMm2: 430_344.918,
  historicTotalContactTarget: 53,
  historicDominantContactTarget: 14
} as const

export interface IntrinsicGlobalPortfolioSchedule {
  readonly maximumRuntimeMs: number
  readonly completeArchiveCapacity: number
  readonly maximumCavityCount: number
  readonly maximumLargestHullGapRatio: number
  readonly explorationAreaCapMm2: number
  readonly productionAreaTargetMm2: number
  readonly historicTotalContactTarget: number
  readonly historicDominantContactTarget: number
}

export interface IntrinsicGlobalFullCandidate {
  readonly source: 'e1-fallback' | 'projected-gap-fill'
  readonly structuralProjectionAttempt: number | undefined
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly measured: IntrinsicSheetlessCompletedLayout
  readonly productionAreaTargetMet: boolean
  readonly historicContactTargetMet: boolean
}

export interface IntrinsicGlobalFillTrace {
  readonly structuralProjectionAttempt: number
  readonly targetRoleId: IntrinsicStructuralHandoff['targetRoleId']
  readonly basinIndex: 0 | 1
  readonly outcome:
    | 'completed-admitted'
    | 'completed-quality-rejected'
    | 'incomplete'
    | 'deadline'
  readonly insertedFillerCount: number | undefined
  readonly nonInertFillCount: number | undefined
  readonly unplacedFillerCount: number | undefined
}

export interface IntrinsicGlobalStructuralOutcome {
  readonly status: IntrinsicGlobalSearchResult['status']
  readonly structuralPieceCount: number
  readonly fillerPieceCount: number
  readonly searchedBasinCount: number
  readonly unavailableQuarterTurnBasinCount: number
  readonly handoffCount: number
  readonly completedSweepCount: number
  readonly separationEvaluationCount: number
  readonly projectionAttemptCount: number
  readonly projectionSuccessCount: number
  readonly sweepTrace: IntrinsicGlobalSearchResult['trace']
  readonly projectionTrace: ReadonlyArray<IntrinsicProjectionAttemptTrace>
}

export interface IntrinsicGlobalPromotionSummary {
  readonly viableCandidateCount: number
  readonly productionAreaCandidateCount: number
  readonly fallbackAreaMm2: number
  readonly selectedAreaMm2: number
  readonly selectedAtOrBelowFallbackArea: boolean
}

export interface IntrinsicGlobalPortfolioResult {
  readonly status: 'completed-candidate' | 'completed-fallback' | 'deadline-fallback' | 'budget-fallback'
  readonly selected: IntrinsicGlobalFullCandidate
  readonly completeArchive: ReadonlyArray<IntrinsicGlobalFullCandidate>
  readonly admittedCandidates: ReadonlyArray<IntrinsicGlobalFullCandidate>
  readonly structuralOutcome: IntrinsicGlobalStructuralOutcome
  readonly promotion: IntrinsicGlobalPromotionSummary
  readonly fillTrace: ReadonlyArray<IntrinsicGlobalFillTrace>
  readonly runtimeMs: number
  readonly maximumRuntimeMs: number
  readonly remainingBudgetMs: number
}

export class IntrinsicGlobalPortfolioError extends Data.TaggedError(
  'IntrinsicGlobalPortfolioError'
)<{
  readonly operation: 'initialize' | 'partition' | 'structural-search' | 'gap-fill' | 'archive'
  readonly message: string
}> {}

interface IntrinsicGlobalPortfolioDependencies {
  readonly runStructural: typeof runIntrinsicSqueezeDisruptSeparate
  readonly fill: (
    input: ConstructIntrinsicStrictStateInput
  ) => Effect.Effect<
    IntrinsicStrictConstructResult,
    | IntrinsicStrictDecoderError
    | IrregularNestingNotImplementedError
    | IrregularGeometryInputError
    | IrregularNfpIfpControlAbortError,
    GeometryKernel | GeometrySettings | NfpIfpService
  >
}

const productionSchedule: IntrinsicGlobalPortfolioSchedule = {
  ...INTRINSIC_GLOBAL_PORTFOLIO_DEFAULTS
}

/** Complete sheetless structural-to-full E4 portfolio. */
export function runIntrinsicGlobalSqueezePortfolio(input: {
  readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly fullE1Placed: ReadonlyArray<IrregularPlacedPiece>
  readonly control?: IrregularNfpIfpControl
}): Effect.Effect<
  IntrinsicGlobalPortfolioResult,
  | IntrinsicGlobalPortfolioError
  | IntrinsicGlobalSearchError
  | IntrinsicExactProjectionError
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return runIntrinsicGlobalSqueezePortfolioWithDependencies(
    input,
    productionSchedule,
    {
      runStructural: runIntrinsicSqueezeDisruptSeparate,
      fill: constructIntrinsicStrictState
    }
  )
}

/** Reduced deterministic seam for orchestration and archive tests. */
export function runIntrinsicGlobalSqueezePortfolioWithDependencies(
  input: {
    readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
    readonly fullE1Placed: ReadonlyArray<IrregularPlacedPiece>
    readonly control?: IrregularNfpIfpControl
  },
  scheduleInput: IntrinsicGlobalPortfolioSchedule,
  dependencies: IntrinsicGlobalPortfolioDependencies
): Effect.Effect<
  IntrinsicGlobalPortfolioResult,
  | IntrinsicGlobalPortfolioError
  | IntrinsicGlobalSearchError
  | IntrinsicExactProjectionError
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const allPreparedPieces = [...input.allPreparedPieces]
    const fullE1Placed = [...input.fullE1Placed]
    const schedule = snapshotSchedule(scheduleInput)
    const startedAt = performance.now()
    const absoluteControl = makeAbsoluteControl(input.control, startedAt, schedule.maximumRuntimeMs)
    const partition = partitionIntrinsicStructuralPieces(allPreparedPieces)
    const fallback = exactFullCandidate({
      source: 'e1-fallback',
      structuralProjectionAttempt: undefined,
      allPreparedPieces,
      placed: fullE1Placed,
      runtimeMs: 0,
      schedule
    })
    if (partition === undefined || fallback === undefined) {
      return yield* portfolioFailure(
        'initialize',
        'the area partition and immutable full E1 fallback must be complete and exact.'
      )
    }

    const structuralAttempt = yield* Effect.matchEffect(
      dependencies.runStructural({
        allPreparedPieces,
        fullE1Placed,
        control: absoluteControl
      }),
      {
        onFailure: (error) => Effect.succeed({ kind: 'failure' as const, error }),
        onSuccess: (result) => Effect.succeed({ kind: 'success' as const, result })
      }
    )
    if (structuralAttempt.kind === 'failure') {
      if (structuralAttempt.error._tag === 'IrregularNfpIfpControlAbortError') {
        if (structuralAttempt.error.reason === 'cancelled') {
          return yield* Effect.fail(structuralAttempt.error)
        }
        return fallbackResult({
          status: 'deadline-fallback',
          fallback,
          partition,
          structural: emptyStructuralResult(fullE1Placed, partition),
          fillTrace: [],
          startedAt,
          schedule
        })
      }
      return yield* Effect.fail(structuralAttempt.error)
    }
    const structural = structuralAttempt.result
    if (!samePartition(partition, structural)) {
      return yield* portfolioFailure(
        'partition',
        'the structural controller partition must match the independently derived area partition.'
      )
    }
    const structuralOutcome = structuralOutcomeFrom(structural)
    if (structural.status !== 'completed') {
      return fallbackResult({
        status:
          structural.status === 'deadline-fallback'
            ? 'deadline-fallback'
            : 'budget-fallback',
        fallback,
        partition,
        structural,
        fillTrace: [],
        startedAt,
        schedule
      })
    }

    const admitted: IntrinsicGlobalFullCandidate[] = []
    const fillTrace: IntrinsicGlobalFillTrace[] = []
    for (const handoff of structural.structuralHandoffs) {
      const remainingBefore = remainingRuntimeMs(startedAt, schedule.maximumRuntimeMs)
      if (remainingBefore <= 0) {
        fillTrace.push(
          deadlineFillTrace({
            handoff,
            insertedFillerCount: 0,
            nonInertFillCount: 0,
            unplacedFillerCount: partition.fillerPieces.length
          })
        )
        return fallbackResult({
          status: 'deadline-fallback',
          fallback,
          partition,
          structural,
          fillTrace,
          startedAt,
          schedule
        })
      }
      const fillAttempt = yield* Effect.matchEffect(
        dependencies.fill({
          allPreparedPieces,
          remainingPreparedPieces: partition.fillerPieces,
          frozenPlaced: handoff.placedCollisionGeometries,
          candidateMode: { kind: 'gap-contained' },
          maximumRuntimeMs: remainingBefore,
          control: absoluteControl
        }),
        {
          onFailure: (error) => Effect.succeed({ kind: 'failure' as const, error }),
          onSuccess: (result) => Effect.succeed({ kind: 'success' as const, result })
        }
      )
      if (fillAttempt.kind === 'failure') {
        if (fillAttempt.error._tag === 'IrregularNfpIfpControlAbortError') {
          if (fillAttempt.error.reason === 'cancelled') return yield* Effect.fail(fillAttempt.error)
          fillTrace.push(
            deadlineFillTrace({
              handoff,
              insertedFillerCount: undefined,
              nonInertFillCount: undefined,
              unplacedFillerCount: undefined
            })
          )
          return fallbackResult({
            status: 'deadline-fallback',
            fallback,
            partition,
            structural,
            fillTrace,
            startedAt,
            schedule
          })
        }
        return yield* Effect.fail(fillAttempt.error)
      }
      const constructed = fillAttempt.result
      const insertedFillerCount =
        constructed.state.placedCollisionGeometries.length -
        handoff.placedCollisionGeometries.length
      const nonInertFillCount = constructed.gapFillEvidence.filter(({ nonInert }) => nonInert).length
      const unplacedFillerCount = constructed.state.unplacedPieceIds.length
      const measured =
        unplacedFillerCount === 0 &&
        insertedFillerCount === partition.fillerPieces.length &&
        constructed.state.placedCollisionGeometries.length === allPreparedPieces.length
          ? exactFullCandidate({
              source: 'projected-gap-fill',
              structuralProjectionAttempt: handoff.projectionAttempt,
              allPreparedPieces,
              placed: constructed.state.placedCollisionGeometries,
              runtimeMs: constructed.runtimeMs,
              schedule
            })
          : undefined
      const admittedCandidate =
        measured !== undefined && candidatePassesAdmission(measured, schedule)
          ? measured
          : undefined
      if (admittedCandidate !== undefined) {
        admitted.push(admittedCandidate)
      }
      const completedTrace: IntrinsicGlobalFillTrace = {
        structuralProjectionAttempt: handoff.projectionAttempt,
        targetRoleId: handoff.targetRoleId,
        basinIndex: handoff.basinIndex,
        outcome:
          measured === undefined
            ? 'incomplete'
            : admittedCandidate === undefined
              ? 'completed-quality-rejected'
              : 'completed-admitted',
        insertedFillerCount: Math.max(0, insertedFillerCount),
        nonInertFillCount,
        unplacedFillerCount
      }
      const checkpoint = yield* portfolioCheckpoint(absoluteControl)
      if (checkpoint === 'deadline') {
        fillTrace.push(
          deadlineFillTrace({
            handoff,
            insertedFillerCount: Math.max(0, insertedFillerCount),
            nonInertFillCount,
            unplacedFillerCount
          })
        )
        return fallbackResult({
          status: 'deadline-fallback',
          fallback,
          partition,
          structural,
          fillTrace,
          startedAt,
          schedule
        })
      }
      fillTrace.push(completedTrace)
    }

    if ((yield* portfolioCheckpoint(absoluteControl)) === 'deadline') {
      return fallbackResult({
        status: 'deadline-fallback',
        fallback,
        partition,
        structural,
        fillTrace,
        startedAt,
        schedule
      })
    }
    const viable = admitted.filter(
      ({ measured }) =>
        measured.canonicalGeometryIdentity !== fallback.measured.canonicalGeometryIdentity
    )
    const retained = retainIntrinsicGlobalFullCandidates(
      viable,
      Math.max(0, schedule.completeArchiveCapacity - 1)
    )
    const selected = retained[0] ?? fallback
    return {
      status: retained.length > 0 ? 'completed-candidate' : 'completed-fallback',
      selected,
      completeArchive: dedupeCompleteArchive(fallback, retained, schedule.completeArchiveCapacity),
      admittedCandidates: retained,
      structuralOutcome,
      promotion: promotionSummary(fallback, viable, selected),
      fillTrace,
      runtimeMs: Math.max(0, performance.now() - startedAt),
      maximumRuntimeMs: schedule.maximumRuntimeMs,
      remainingBudgetMs: remainingRuntimeMs(startedAt, schedule.maximumRuntimeMs)
    }
  })
}

/** Retains viable exact layouts, then ranks topology before the area milestone and area. */
export function retainIntrinsicGlobalFullCandidates(
  candidates: ReadonlyArray<IntrinsicGlobalFullCandidate>,
  capacity: number
): ReadonlyArray<IntrinsicGlobalFullCandidate> {
  const unique = new Map<string, IntrinsicGlobalFullCandidate>()
  for (const candidate of candidates) {
    const key = candidate.measured.canonicalGeometryIdentity
    const existing = unique.get(key)
    if (existing === undefined || compareFullCandidates(candidate, existing) < 0) {
      unique.set(key, candidate)
    }
  }
  const values = [...unique.values()]
  return values
    .filter(
      (candidate) =>
        !values.some(
          (other) =>
            other.measured.canonicalGeometryIdentity !==
              candidate.measured.canonicalGeometryIdentity &&
            dominatesFullCandidate(other, candidate)
        )
    )
    .toSorted(compareFullCandidates)
    .slice(0, Math.max(0, capacity))
}

function exactFullCandidate(input: {
  readonly source: IntrinsicGlobalFullCandidate['source']
  readonly structuralProjectionAttempt: number | undefined
  readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly runtimeMs: number
  readonly schedule: IntrinsicGlobalPortfolioSchedule
}): IntrinsicGlobalFullCandidate | undefined {
  if (!exactPieceCoverage(input.allPreparedPieces, input.placed)) return undefined
  const state = new IrregularBeamState({
    remainingPreparedPieces: [],
    placedCollisionGeometries: input.placed,
    placementOrder: input.placed.map(placedPieceId)
  })
  const measured = measureIntrinsicSheetlessCompletedLayout(state, input.runtimeMs)
  if (measured === undefined) return undefined
  return {
    source: input.source,
    structuralProjectionAttempt: input.structuralProjectionAttempt,
    placedCollisionGeometries: measured.placedCollisionGeometries,
    measured,
    productionAreaTargetMet:
      measured.metrics.envelopeAreaMm2 <= input.schedule.productionAreaTargetMm2,
    historicContactTargetMet:
      measured.metrics.totalStructuralContacts >= input.schedule.historicTotalContactTarget &&
      measured.metrics.dominantStructuralContacts >= input.schedule.historicDominantContactTarget
  }
}

function candidatePassesAdmission(
  candidate: IntrinsicGlobalFullCandidate,
  schedule: IntrinsicGlobalPortfolioSchedule
): boolean {
  const metrics = candidate.measured.metrics
  return (
    metrics.enclosedCavityCount <= schedule.maximumCavityCount &&
    metrics.largestOccupiedHullGapRatio <= schedule.maximumLargestHullGapRatio &&
    metrics.envelopeAreaMm2 <= schedule.explorationAreaCapMm2
  )
}

function dominatesFullCandidate(
  first: IntrinsicGlobalFullCandidate,
  second: IntrinsicGlobalFullCandidate
): boolean {
  const a = first.measured.metrics
  const b = second.measured.metrics
  const noWorse =
    a.enclosedCavityCount <= b.enclosedCavityCount &&
    a.totalEnclosedCavityAreaMm2 <= b.totalEnclosedCavityAreaMm2 &&
    a.largestOccupiedHullGapRatio <= b.largestOccupiedHullGapRatio &&
    a.envelopeAreaMm2 <= b.envelopeAreaMm2 &&
    a.envelopeMaximumSideMm <= b.envelopeMaximumSideMm &&
    a.envelopeSpanMm <= b.envelopeSpanMm &&
    a.occupiedHullWasteRatio <= b.occupiedHullWasteRatio
  const better =
    a.enclosedCavityCount < b.enclosedCavityCount ||
    a.totalEnclosedCavityAreaMm2 < b.totalEnclosedCavityAreaMm2 ||
    a.largestOccupiedHullGapRatio < b.largestOccupiedHullGapRatio ||
    a.envelopeAreaMm2 < b.envelopeAreaMm2 ||
    a.envelopeMaximumSideMm < b.envelopeMaximumSideMm ||
    a.envelopeSpanMm < b.envelopeSpanMm ||
    a.occupiedHullWasteRatio < b.occupiedHullWasteRatio
  return noWorse && better
}

function compareFullCandidates(
  first: IntrinsicGlobalFullCandidate,
  second: IntrinsicGlobalFullCandidate
): number {
  const a = first.measured.metrics
  const b = second.measured.metrics
  return (
    a.enclosedCavityCount - b.enclosedCavityCount ||
    a.largestOccupiedHullGapRatio - b.largestOccupiedHullGapRatio ||
    Number(second.productionAreaTargetMet) - Number(first.productionAreaTargetMet) ||
    a.envelopeAreaMm2 - b.envelopeAreaMm2 ||
    a.envelopeMaximumSideMm - b.envelopeMaximumSideMm ||
    a.envelopeSpanMm - b.envelopeSpanMm ||
    a.totalEnclosedCavityAreaMm2 - b.totalEnclosedCavityAreaMm2 ||
    a.occupiedHullWasteRatio - b.occupiedHullWasteRatio ||
    first.measured.canonicalGeometryIdentity.localeCompare(
      second.measured.canonicalGeometryIdentity
    )
  )
}

function dedupeCompleteArchive(
  fallback: IntrinsicGlobalFullCandidate,
  admitted: ReadonlyArray<IntrinsicGlobalFullCandidate>,
  capacity: number
): ReadonlyArray<IntrinsicGlobalFullCandidate> {
  const result = [fallback]
  for (const candidate of admitted) {
    if (
      result.length >= Math.max(1, capacity) ||
      result.some(
        ({ measured }) =>
          measured.canonicalGeometryIdentity === candidate.measured.canonicalGeometryIdentity
      )
    ) {
      continue
    }
    result.push(candidate)
  }
  return result
}

function fallbackResult(input: {
  readonly status: 'deadline-fallback' | 'budget-fallback'
  readonly fallback: IntrinsicGlobalFullCandidate
  readonly partition: NonNullable<ReturnType<typeof partitionIntrinsicStructuralPieces>>
  readonly structural: IntrinsicGlobalSearchResult
  readonly fillTrace: ReadonlyArray<IntrinsicGlobalFillTrace>
  readonly startedAt: number
  readonly schedule: IntrinsicGlobalPortfolioSchedule
}): IntrinsicGlobalPortfolioResult {
  return {
    status: input.status,
    selected: input.fallback,
    completeArchive: [input.fallback],
    admittedCandidates: [],
    structuralOutcome: structuralOutcomeFrom(input.structural),
    promotion: promotionSummary(input.fallback, [], input.fallback),
    fillTrace: input.fillTrace,
    runtimeMs: Math.max(0, performance.now() - input.startedAt),
    maximumRuntimeMs: input.schedule.maximumRuntimeMs,
    remainingBudgetMs: remainingRuntimeMs(input.startedAt, input.schedule.maximumRuntimeMs)
  }
}

function promotionSummary(
  fallback: IntrinsicGlobalFullCandidate,
  viable: ReadonlyArray<IntrinsicGlobalFullCandidate>,
  selected: IntrinsicGlobalFullCandidate
): IntrinsicGlobalPromotionSummary {
  const fallbackAreaMm2 = fallback.measured.metrics.envelopeAreaMm2
  const selectedAreaMm2 = selected.measured.metrics.envelopeAreaMm2
  return {
    viableCandidateCount: viable.length,
    productionAreaCandidateCount: viable.filter(({ productionAreaTargetMet }) =>
      productionAreaTargetMet
    ).length,
    fallbackAreaMm2,
    selectedAreaMm2,
    selectedAtOrBelowFallbackArea: selectedAreaMm2 <= fallbackAreaMm2
  }
}

function structuralOutcomeFrom(
  structural: IntrinsicGlobalSearchResult
): IntrinsicGlobalStructuralOutcome {
  return {
    status: structural.status,
    structuralPieceCount: structural.partition.structuralPieces.length,
    fillerPieceCount: structural.partition.fillerPieces.length,
    searchedBasinCount: structural.searchedBasinCount,
    unavailableQuarterTurnBasinCount: structural.unavailableQuarterTurnBasinCount,
    handoffCount: structural.structuralHandoffs.length,
    completedSweepCount: structural.completedSweepCount,
    separationEvaluationCount: structural.separationEvaluationCount,
    projectionAttemptCount: structural.projectionAttemptCount,
    projectionSuccessCount: structural.projectionSuccessCount,
    sweepTrace: structural.trace,
    projectionTrace: structural.projectionTrace
  }
}

function emptyStructuralResult(
  fullE1Placed: ReadonlyArray<IrregularPlacedPiece>,
  partition: NonNullable<ReturnType<typeof partitionIntrinsicStructuralPieces>>
): IntrinsicGlobalSearchResult {
  return {
    status: 'deadline-fallback',
    fullE1Fallback: fullE1Placed,
    partition,
    targetRoles: [],
    searchedBasinCount: 0,
    unavailableQuarterTurnBasinCount: 0,
    structuralHandoffs: [],
    trace: [],
    projectionTrace: [],
    completedSweepCount: 0,
    separationEvaluationCount: 0,
    projectionAttemptCount: 0,
    projectionSuccessCount: 0,
    runtimeMs: 0
  }
}

function deadlineFillTrace(input: {
  readonly handoff: IntrinsicStructuralHandoff
  readonly insertedFillerCount: number | undefined
  readonly nonInertFillCount: number | undefined
  readonly unplacedFillerCount: number | undefined
}): IntrinsicGlobalFillTrace {
  return {
    structuralProjectionAttempt: input.handoff.projectionAttempt,
    targetRoleId: input.handoff.targetRoleId,
    basinIndex: input.handoff.basinIndex,
    outcome: 'deadline',
    insertedFillerCount: input.insertedFillerCount,
    nonInertFillCount: input.nonInertFillCount,
    unplacedFillerCount: input.unplacedFillerCount
  }
}

function samePartition(
  expected: NonNullable<ReturnType<typeof partitionIntrinsicStructuralPieces>>,
  structural: IntrinsicGlobalSearchResult
): boolean {
  return (
    samePieceIds(expected.structuralPieces, structural.partition.structuralPieces) &&
    samePieceIds(expected.fillerPieces, structural.partition.fillerPieces)
  )
}

function samePieceIds(
  first: ReadonlyArray<IrregularPreparedPiece>,
  second: ReadonlyArray<IrregularPreparedPiece>
): boolean {
  const firstIds = first.map(preparedPieceId).toSorted()
  const secondIds = second.map(preparedPieceId).toSorted()
  return (
    firstIds.length === secondIds.length &&
    firstIds.every((pieceId, index) => pieceId === secondIds[index])
  )
}

function exactPieceCoverage(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  placed: ReadonlyArray<IrregularPlacedPiece>
): boolean {
  const expected = pieces.map(preparedPieceId).toSorted()
  const actual = placed.map(placedPieceId).toSorted()
  return (
    new Set(expected).size === expected.length &&
    new Set(actual).size === actual.length &&
    expected.length === actual.length &&
    expected.every((pieceId, index) => pieceId === actual[index])
  )
}

function snapshotSchedule(
  schedule: IntrinsicGlobalPortfolioSchedule
): IntrinsicGlobalPortfolioSchedule {
  return {
    maximumRuntimeMs: schedule.maximumRuntimeMs,
    completeArchiveCapacity: schedule.completeArchiveCapacity,
    maximumCavityCount: schedule.maximumCavityCount,
    maximumLargestHullGapRatio: schedule.maximumLargestHullGapRatio,
    explorationAreaCapMm2: schedule.explorationAreaCapMm2,
    productionAreaTargetMm2: schedule.productionAreaTargetMm2,
    historicTotalContactTarget: schedule.historicTotalContactTarget,
    historicDominantContactTarget: schedule.historicDominantContactTarget
  }
}

function makeAbsoluteControl(
  upstream: IrregularNfpIfpControl | undefined,
  startedAt: number,
  maximumRuntimeMs: number
): IrregularNfpIfpControl {
  return {
    checkpoint: (phase) =>
      Effect.gen(function* () {
        if (upstream !== undefined) yield* upstream.checkpoint(phase)
        if (performance.now() - startedAt >= maximumRuntimeMs) {
          return yield* Effect.fail(
            new IrregularNfpIfpControlAbortError({
              reason: 'deadline',
              message: 'the intrinsic global portfolio reached its absolute deadline.'
            })
          )
        }
      })
  }
}

function portfolioCheckpoint(
  control: IrregularNfpIfpControl
): Effect.Effect<'continue' | 'deadline', IrregularNfpIfpControlAbortError> {
  return Effect.matchEffect(control.checkpoint('candidate-points'), {
    onFailure: (error) =>
      error.reason === 'deadline' ? Effect.succeed('deadline' as const) : Effect.fail(error),
    onSuccess: () => Effect.succeed('continue' as const)
  })
}

function remainingRuntimeMs(startedAt: number, maximumRuntimeMs: number): number {
  return Math.max(0, maximumRuntimeMs - Math.max(0, performance.now() - startedAt))
}

function portfolioFailure(
  operation: IntrinsicGlobalPortfolioError['operation'],
  message: string
): Effect.Effect<never, IntrinsicGlobalPortfolioError> {
  return Effect.fail(new IntrinsicGlobalPortfolioError({ operation, message }))
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function placedPieceId(piece: IrregularPlacedPiece): PieceId {
  return piece.placement.pieceId ?? piece.placement.sourcePieceId
}
