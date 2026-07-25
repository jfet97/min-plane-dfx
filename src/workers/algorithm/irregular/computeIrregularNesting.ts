import { Data, Effect, Layer } from 'effect'
import { performance } from 'node:perf_hooks'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { PieceId } from '@shared/domain/ids.js'
import { SheetSpec, type NestingRequest } from '@shared/domain/nesting.js'
import {
  CollisionGeometryDiagnostic,
  IrregularPlacedPiece,
  IrregularLayoutScoreSummary,
  IrregularPortfolioResult,
  IrregularPortfolioProgress,
  IrregularPriorityOrderKey,
  IrregularPreparedPiece,
  IrregularTransformCandidate,
  type IrregularNestingSettings
} from '@shared/irregular/domain.js'
import { intrinsicSharedArchiveEligibility } from '@shared/irregular/executionMode.js'
import { CollisionGeometryBuilder } from '../../irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
  IrregularNfpIfpControlAbortError,
  IrregularNestingNotImplementedError,
  IrregularNestingPortfolio,
  IrregularPortfolioError,
  NfpIfpService,
  TransformGenerator
} from '../../irregular/services.js'
import { sortPiecesForNesting } from '../sortPiecesForNesting.js'
import {
  IrregularLayoutScore,
  IrregularLayoutScoringError,
  IrregularLayoutScorer
} from './irregularLayoutScorer.js'
import {
  IrregularPlacementScorer,
  IrregularPlacementScoringError
} from './irregularPlacementScorer.js'
import { IrregularBeamState } from './irregularBeamState.js'
import {
  IrregularNestingPortfolioLive,
  type IrregularPortfolioMetrics,
  type IrregularPortfolioPhaseMeasurement
} from './portfolioSearch.js'
import { PriorityOrderServiceLive } from './priorityOrderService.js'
import type { EmitIrregularDecisionTrace } from './decisionTrace.js'
import {
  makeIntrinsicSharedArchiveEndpoint,
  retainRankedSharedArchive,
  intrinsicSharedArchiveProductionValid,
  runIntrinsicSharedArchivePortfolio,
  selectFittingSharedArchive,
  selectIntrinsicSharedArchiveWinner,
  type IntrinsicSharedArchiveEndpoint
} from './intrinsicSharedArchivePortfolio.js'
import {
  runIntrinsicReconstructionPortfolio,
  type IntrinsicReconstructionSeed
} from './intrinsicReconstructionPortfolio.js'
import {
  INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS,
  runIntrinsicCapacityMode,
  runIntrinsicCapacitySchedulerColdQuantum,
  type IntrinsicCapacityModeResult,
  type IntrinsicCapacityTrace
} from './intrinsicCapacityMode.js'
import {
  preflightIntrinsicCompleteCapacity,
  type IntrinsicCapacityError,
  type IntrinsicCapacityPreflightOutcome
} from './intrinsicCapacityPreflight.js'
import type { IntrinsicCapacityPrefixSource } from './intrinsicCapacityPrefixes.js'
import type { IntrinsicCapacityEndpoint } from './intrinsicCapacityEndpoint.js'
import {
  observeIntrinsicShortSideOrientations,
  type IntrinsicShortSideObserverTrace
} from './intrinsicShortSideObserver.js'
import {
  observeIntrinsicShortSidePairFold,
  type IntrinsicShortSideConstructionKind,
  type IntrinsicShortSidePairFoldTrace
} from './intrinsicShortSidePairFoldObserver.js'
import {
  measureIntrinsicCapacityShadowTelemetry,
  type IntrinsicCapacityShadowTelemetry
} from './intrinsicCapacityTelemetry.js'
import {
  observeIntrinsicPlaceDeferCompleteShadow,
  type IntrinsicPlaceDeferTrace
} from './intrinsicPlaceDeferCompleteShadow.js'

/** Reports that a prepared piece has no imported geometry available to the worker. */
export class IrregularComputeError extends Data.TaggedError('IrregularComputeError')<{
  readonly preparedPieceId: PieceId
  readonly sourcePieceId: PieceId
  readonly message: string
}> {}

/** One real beam state emitted by the irregular decoder. */
export interface IrregularStateSnapshot {
  readonly stepIndex: number
  readonly beamRank: number
  readonly candidateCount: number
  readonly source?: 'beam' | 'shared-archive'
  readonly state: IrregularBeamState
}

/** Benchmark-only measurements for materializing the selected portfolio result. */
export interface IrregularFinalizationMetrics {
  readonly reconstructionElapsedMs: number
  readonly finalScoreElapsedMs: number
}

/** Synchronous worker-facing notification for one selected real beam state. */
export interface ComputeIrregularNestingOptions {
  readonly emitStateSnapshot?: (snapshot: IrregularStateSnapshot, beamWidth: number) => void
  readonly emitDecisionTrace?: EmitIrregularDecisionTrace
  readonly emitPortfolioProgress?: (progress: IrregularPortfolioProgress) => Effect.Effect<void>
  readonly isCancelled?: () => boolean
  /** standalone benchmark hook; measurements never enter normal app output. */
  readonly onPortfolioPhase?: (measurement: IrregularPortfolioPhaseMeasurement) => void
  /** standalone benchmark hook; metrics never enter normal app output. */
  readonly onPortfolioMetrics?: (metrics: IrregularPortfolioMetrics) => void
  /** standalone benchmark hook; metrics never enter normal app output. */
  readonly onFinalizationMetrics?: (metrics: IrregularFinalizationMetrics) => void
  /** paired-comparison hook; production always keeps capacity prefix reuse on. */
  readonly capacityControlArm?: 'disable-prefix-reuse'
  /** standalone benchmark hook; capacity phase timings default off in production. */
  readonly captureCapacityPhaseTimings?: boolean
  /** observer-only pressure and no-skip probe; never consumed by routing. */
  readonly captureCapacityShadowTelemetry?: boolean
  /** observer-only protected warm-prefix continuations; never consumed by selection. */
  readonly captureCapacityWarmPrefixTelemetry?: boolean
  /** benchmark artifact hook; receives exact warm endpoints without selecting them. */
  readonly onCapacityWarmPrefixLane?: (lane: {
    readonly sourceRole: string
    readonly prefixDepth: number
    readonly endpoint: IntrinsicCapacityEndpoint | undefined
  }) => void
  /** Legacy explicit marker; deterministic v1 is the production Compact default. */
  readonly intrinsicAnytimeSchedulerMode?: 'deterministic-v1'
  /** Experimental subset retention; terminal capacity comparator is unchanged. */
  readonly intrinsicCapacityRetentionShadow?: 'area-first' | 'axis-buckets'
  /** Independent observer-only generic topology-frontier lane. */
  readonly captureCapacityCohesionShadow?: boolean
  /** Benchmark hook for the independent exact cohesion endpoint. */
  readonly onCapacityCohesionShadowLane?: (
    endpoint: IntrinsicCapacityEndpoint | undefined
  ) => void
  /** Benchmark hook exposing the exact prepared order without affecting search. */
  readonly onPreparedPieces?: (
    preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  ) => void
  /** Opt-in complete-capable place/defer shadow producer. */
  readonly captureExperimentalPlaceDeferCompleteShadow?: boolean
  readonly onExperimentalPlaceDeferCompleteEndpoint?: (
    endpoint: IntrinsicSharedArchiveEndpoint | undefined
  ) => void
  /** Paired benchmark arm; production keeps focused reconstruction enabled. */
  readonly focusedCompleteReconstructionControlArm?: 'disable'
  /** Zero-search q0/q90 observation over settled complete Compact endpoints. */
  readonly captureIntrinsicShortSideObserver?: boolean
  /** Receives the observer trace without affecting production selection or output. */
  readonly onIntrinsicShortSideObserver?: (trace: IntrinsicShortSideObserverTrace) => void
  /** Benchmark artifact hook for the exact observer-selected complete geometry. */
  readonly onIntrinsicShortSideObserverWinner?: (
    winner:
      | {
          readonly canonicalGeometryHash: string
          readonly rotationDeg: 0 | 90
          readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
        }
      | undefined
  ) => void
  /** Bounded exhaustive pair fold with no NFP or beam search. */
  readonly captureIntrinsicShortSidePairFoldObserver?: boolean
  /** Benchmark hook for one admitted exact pair fold. */
  readonly onIntrinsicShortSidePairFoldObserverWinner?: (
    winner: ReadonlyArray<IrregularPlacedPiece> | undefined
  ) => void
}

export interface IntrinsicFocusedCompleteReconstructionTrace {
  readonly version: 'intrinsic-focused-complete-reconstruction-v1'
  readonly status:
    | 'completed'
    | 'duplicate-order'
    | 'evaluation-cap'
    | 'deadline'
    | 'incomplete'
    | 'failed-protected-fallback'
    | 'skipped-preflight-proven-impossible'
    | 'skipped-no-fitting-protected-endpoint'
  readonly sourceCanonicalGeometryHash: string | undefined
  readonly candidateCanonicalGeometryHash: string | undefined
  readonly selectedCanonicalGeometryHash: string | undefined
  readonly consumedCandidateEvaluations: number
  readonly candidateEvaluationAccountingComplete: boolean
  readonly runtimeMs: number
  readonly outputInfluence: 'selected' | 'protected-fallback' | 'none'
  readonly failureReason: string | undefined
}

export interface IntrinsicAnytimeSchedulerTrace {
  readonly version: 'intrinsic-anytime-scheduler-v1'
  readonly coldQuantumDepths: number
  readonly coldStartStatus: 'paused' | 'settled'
  readonly coldStartCompletedDepths: number
  readonly coldStartConsumedPlacementEvaluations: number
  readonly coldCheckpointReused: boolean
  readonly warmPrefixEndpointsAdmitted: boolean
  readonly cancellationReason: 'complete-endpoint-fitted' | 'complete-cohort-miss' | undefined
  readonly quanta: ReadonlyArray<{
    readonly ordinal: number
    readonly cohort: 'partial' | 'complete' | 'experimental-complete'
    readonly producerRole:
      | 'capacity-cold'
      | 'legacy-complete'
      | 'capacity-warm-prefix'
      | 'experimental-place-defer-complete'
    readonly outcome: 'checkpointed' | 'settled' | 'cancelled' | 'censored'
  }>
}

/** Verifies scheduler chronology and legal producer-state transitions. */
export function intrinsicAnytimeSchedulerTraceValid(
  trace: IntrinsicAnytimeSchedulerTrace
): boolean {
  const { quanta } = trace
  if (
    quanta.length < 2 ||
    quanta.some(({ ordinal }, index) => ordinal !== index) ||
    quanta[0]?.producerRole !== 'capacity-cold' ||
    quanta[0]?.outcome !== (trace.coldStartStatus === 'paused' ? 'checkpointed' : 'settled')
  ) {
    return false
  }
  const completeIndexes = quanta.flatMap(({ producerRole }, index) =>
    producerRole === 'legacy-complete' ? [index] : []
  )
  if (completeIndexes.length === 0) return false
  const completeIndex = completeIndexes[completeIndexes.length - 1]
  if (completeIndex === undefined) return false
  if (
    completeIndexes.some(
      (index, ordinal) =>
        quanta[index]?.outcome !==
        (ordinal === completeIndexes.length - 1 ? 'settled' : 'checkpointed')
    )
  ) {
    return false
  }
  const experimentalIndexes = quanta.flatMap(({ producerRole }, index) =>
    producerRole === 'experimental-place-defer-complete' ? [index] : []
  )
  if (
    experimentalIndexes.length > 1 ||
    experimentalIndexes.some((index) => index <= completeIndex)
  ) {
    return false
  }
  const laterPartial = quanta.filter(
    ({ cohort }, index) => index > completeIndex && cohort === 'partial'
  )
  const laterCold = laterPartial.filter(
    ({ producerRole }) => producerRole === 'capacity-cold'
  )
  const laterWarm = laterPartial.filter(
    ({ producerRole }) => producerRole === 'capacity-warm-prefix'
  )
  const coldSettledBeforeComplete = quanta.some(
    ({ producerRole, outcome }, index) =>
      index < completeIndex &&
      producerRole === 'capacity-cold' &&
      outcome === 'settled'
  )
  const firstLaterPartialIndex = quanta.findIndex(
    ({ cohort }, index) => index > completeIndex && cohort === 'partial'
  )
  if (
    experimentalIndexes.some(
      (index) => firstLaterPartialIndex >= 0 && index >= firstLaterPartialIndex
    )
  ) {
    return false
  }
  if (trace.cancellationReason === 'complete-cohort-miss') {
    if (laterPartial.some(({ outcome }) => outcome === 'cancelled')) {
      return false
    }
    if (
      trace.coldStartStatus === 'paused' &&
      !coldSettledBeforeComplete &&
      !laterCold.some(({ outcome }) => outcome === 'settled' || outcome === 'censored')
    ) {
      return false
    }
    const warmCheckpoints = laterWarm.filter(
      ({ outcome }) => outcome === 'checkpointed'
    ).length
    const warmTerminals = laterWarm.filter(
      ({ outcome }) => outcome === 'settled' || outcome === 'censored'
    ).length
    return warmTerminals >= warmCheckpoints
  }
  if (trace.cancellationReason === 'complete-endpoint-fitted') {
    if (coldSettledBeforeComplete) {
      return laterCold.length === 0 && laterWarm.length === 0
    }
    return (
      trace.coldStartStatus === 'paused' &&
      laterCold.length === 1 &&
      laterCold[0]?.outcome === 'cancelled' &&
      laterWarm.length === 0
    )
  }
  return (
    laterPartial.length === 0 &&
    (trace.coldStartStatus === 'settled' || coldSettledBeforeComplete)
  )
}

/** Plain algorithm output before any worker protocol or history DTO adaptation. */
export interface IrregularComputeResult {
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly score: IrregularLayoutScore
  readonly unplacedPieceIds: ReadonlyArray<PieceId>
  readonly diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>
  readonly sortedPieceIds: ReadonlyArray<PieceId>
  readonly stateSnapshots: ReadonlyArray<IrregularStateSnapshot>
  readonly beamWidth: number
  readonly portfolio: IrregularPortfolioResult
  /** Present only when intrinsic capacity mode settled this result. */
  readonly capacityTrace?: IntrinsicCapacityTrace
  /** Opt-in observer output; never consumed by routing or ranking. */
  readonly capacityShadowTelemetry?: IntrinsicCapacityShadowTelemetry
  /** Present only for the opt-in deterministic scheduler experiment. */
  readonly intrinsicAnytimeSchedulerTrace?: IntrinsicAnytimeSchedulerTrace
  /** Observer-only experimental complete-capable producer. */
  readonly experimentalPlaceDeferTrace?: IntrinsicPlaceDeferTrace
  /** Present only when the focused complete reconstruction experiment is enabled. */
  readonly focusedCompleteReconstructionTrace?: IntrinsicFocusedCompleteReconstructionTrace
  /** Present only when the zero-search Compact short-side observer is enabled. */
  readonly intrinsicShortSideObserverTrace?: IntrinsicShortSideObserverTrace
  /** Present only when the bounded short-edge pair-fold observer is enabled. */
  readonly intrinsicShortSidePairFoldTrace?: IntrinsicShortSidePairFoldTrace
}

export type IrregularComputeErrorType =
  | IrregularComputeError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError
  | IrregularNestingNotImplementedError
  | IrregularPortfolioError
  | IrregularPlacementScoringError
  | IrregularLayoutScoringError

export function computeIrregularNesting(
  request: NestingRequest,
  options?: ComputeIrregularNestingOptions
): Effect.Effect<
  IrregularComputeResult,
  IrregularComputeErrorType,
  | GeometrySettings
  | GeometryKernel
  | CollisionGeometryBuilder
  | TransformGenerator
  | NfpIfpService
  | IrregularPlacementScorer
  | IrregularLayoutScorer
> {
  return Effect.gen(function* () {
    const settings = yield* GeometrySettings
    const sortedPieces = sortPiecesForNesting(request.pieces)
    const sourcePieces = request.sourcePieces ?? []
    const preparedPieces: IrregularPreparedPiece[] = []
    const diagnostics: CollisionGeometryDiagnostic[] = []
    const geometryBuilder = yield* CollisionGeometryBuilder
    const geometryKernel = yield* GeometryKernel
    const transformGenerator = yield* TransformGenerator
    const layoutScorer = yield* IrregularLayoutScorer

    for (const prepared of sortedPieces) {
      const source = findSourcePiece(prepared.sourcePieceId, prepared.id, sourcePieces)
      if (source === undefined) {
        return yield* Effect.fail(
          new IrregularComputeError({
            preparedPieceId: prepared.id,
            sourcePieceId: prepared.sourcePieceId,
            message: `No imported source geometry was found for prepared piece ${prepared.id}.`
          })
        )
      }

      const collisionGeometry = yield* geometryBuilder.buildPiece({
        piece: source,
        totalPaddingMm: request.padding
      })
      const allowRotation = request.options.allowGlobalRotation && prepared.allowRotation
      const allowMirror =
        (request.options.allowGlobalMirror ?? true) && (prepared.allowMirror ?? true)
      const transforms = yield* transformGenerator.generateTransforms({
        geometry: collisionGeometry,
        allowRotation,
        allowMirror,
        geometrySettings: settings.geometry,
        settings: settings.optimizer
      })
      preparedPieces.push(
        new IrregularPreparedPiece({
          pieceId: prepared.id,
          interchangeabilityKey: prepared.interchangeabilityKey ?? prepared.id,
          source,
          allowMirror,
          collisionGeometry,
          transforms,
          priorityOrderKey: new IrregularPriorityOrderKey({
            longSideMm: prepared.paddedBounds.longestEdge,
            areaMm2: prepared.paddedBounds.area,
            imbalanceMm: prepared.paddedBounds.imbalance
          })
        })
      )
      diagnostics.push(...collisionGeometry.diagnostics)
    }
    options?.onPreparedPieces?.(preparedPieces)

    const portfolioService = yield* Effect.service(IrregularNestingPortfolio).pipe(
      Effect.provide(
        IrregularNestingPortfolioLive.pipe(Layer.provideMerge(PriorityOrderServiceLive))
      )
    )
    return yield* coordinateIntrinsicSharedArchive({
      request,
      settings,
      preparedPieces,
      diagnostics,
      sortedPieceIds: sortedPieces.map((piece) => piece.id),
      portfolioService,
      geometryKernel,
      layoutScorer,
      options
    })
  })
}

interface SingleSheetDecode {
  readonly sheet: SheetSpec
  readonly portfolio: IrregularPortfolioResult
  readonly terminalState: IrregularBeamState | undefined
  readonly stateSnapshots: ReadonlyArray<IrregularStateSnapshot>
  readonly metrics: IrregularPortfolioMetrics | undefined
}

interface IrregularSearchCoordinatorInput {
  readonly request: NestingRequest
  readonly settings: IrregularNestingSettings
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>
  readonly sortedPieceIds: ReadonlyArray<PieceId>
  readonly portfolioService: IrregularNestingPortfolio
  readonly geometryKernel: GeometryKernel.Service
  readonly layoutScorer: IrregularLayoutScorer.Service
  readonly options: ComputeIrregularNestingOptions | undefined
}

/** Runs the intrinsic archive as the compact production path. */
function coordinateIntrinsicSharedArchive(
  input: IrregularSearchCoordinatorInput
): Effect.Effect<
  IrregularComputeResult,
  IrregularComputeErrorType,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const coordinatorStartedAt = performance.now()
    const archiveEnabled = isIntrinsicSharedArchiveEligible(input.settings)
    const shortSideProfileRequested =
      input.settings.optimizer.intrinsicObjectiveProfileId === 'short-side'
    const focusedCompleteReconstructionEnabled =
      input.options?.focusedCompleteReconstructionControlArm !== 'disable'
    const archiveDiagnostics: CollisionGeometryDiagnostic[] = []
    let selected: MaterializedDecode
    let capacityShadowTelemetry: IntrinsicCapacityShadowTelemetry | undefined
    let intrinsicAnytimeSchedulerTrace: IntrinsicAnytimeSchedulerTrace | undefined
    let experimentalPlaceDeferTrace: IntrinsicPlaceDeferTrace | undefined
    let focusedCompleteReconstructionTrace:
      | IntrinsicFocusedCompleteReconstructionTrace
      | undefined
    let settledCompleteArchiveForShortSideObserver:
      | ReadonlyArray<IntrinsicSharedArchiveEndpoint>
      | undefined
    let intrinsicShortSideObserverTrace: IntrinsicShortSideObserverTrace | undefined
    let intrinsicShortSidePairFoldTrace:
      | IntrinsicShortSidePairFoldTrace
      | undefined

    if (archiveEnabled) {
      settledCompleteArchiveForShortSideObserver = []
      yield* emitSharedArchiveProgress(
        input,
        'shared_archive',
        undefined,
        performance.now() - coordinatorStartedAt
      )
      const control =
        input.options?.isCancelled === undefined
          ? undefined
          : {
              checkpoint: () =>
                input.options?.isCancelled?.() === true
                  ? Effect.fail(
                      new IrregularNfpIfpControlAbortError({
                        reason: 'cancelled',
                        message: 'intrinsic shared archive was cancelled'
                      })
                    )
                  : Effect.void
            }
      const preflightStartedAt = performance.now()
      const preflight = yield* preflightIntrinsicCompleteCapacity(
        input.request.sheet,
        input.preparedPieces,
        control
      ).pipe(Effect.mapError(mapIntrinsicCapacityError))
      const preflightRuntimeMs = Math.max(0, performance.now() - preflightStartedAt)
      const capacityRetentionMode =
        input.options?.intrinsicCapacityRetentionShadow === 'area-first'
          ? ('area-first-shadow' as const)
          : input.options?.intrinsicCapacityRetentionShadow === 'axis-buckets'
            ? ('axis-buckets-shadow' as const)
            : ('cohesion-frontier' as const)
      if (input.options?.captureCapacityShadowTelemetry === true) {
        capacityShadowTelemetry = yield* measureIntrinsicCapacityShadowTelemetry({
          sheet: input.request.sheet,
          preparedPieces: input.preparedPieces,
          preflight
        })
      }
      const capacityOptions = {
        ...(input.options?.capacityControlArm === 'disable-prefix-reuse'
          ? { disablePrefixReuse: true }
          : {}),
        ...(input.options?.captureCapacityPhaseTimings === true
          ? { capturePhaseTimings: true }
          : {}),
        ...(input.options?.captureCapacityWarmPrefixTelemetry === true
          ? { captureWarmPrefixTelemetry: true }
          : {}),
        ...(input.options?.captureCapacityCohesionShadow === true
          ? { captureCohesionShadow: true }
          : {}),
        ...(input.options?.onCapacityCohesionShadowLane === undefined
          ? {}
          : {
              onCohesionShadowLane:
                input.options.onCapacityCohesionShadowLane
            }),
        ...(input.options?.onCapacityWarmPrefixLane === undefined
          ? {}
          : { onWarmPrefixLane: input.options.onCapacityWarmPrefixLane }),
        retentionMode: capacityRetentionMode
      }
      if (preflight.kind === 'proven_impossible') {
        if (focusedCompleteReconstructionEnabled) {
          focusedCompleteReconstructionTrace = {
            version: 'intrinsic-focused-complete-reconstruction-v1',
            status: 'skipped-preflight-proven-impossible',
            sourceCanonicalGeometryHash: undefined,
            candidateCanonicalGeometryHash: undefined,
            selectedCanonicalGeometryHash: undefined,
            consumedCandidateEvaluations: 0,
            candidateEvaluationAccountingComplete: true,
            runtimeMs: 0,
            outputInfluence: 'none',
            failureReason: undefined
          }
        }
        const capacity = yield* runIntrinsicCapacityMode({
          sheet: input.request.sheet,
          preparedPieces: input.preparedPieces,
          routing: 'preflight-proven-impossible',
          preflight,
          prefixSources: [],
          preflightRuntimeMs,
          ...capacityOptions,
          ...(control === undefined ? {} : { control })
        }).pipe(Effect.mapError(mapIntrinsicCapacityError))
        selected = yield* materializeIntrinsicCapacityResult(input, capacity)
        archiveDiagnostics.push(...intrinsicCapacityDiagnostics(preflight, capacity))
        yield* emitSharedArchiveProgress(
          input,
          'completed',
          selected.portfolio.score,
          performance.now() - coordinatorStartedAt
        )
      } else {
        const schedulerEnabled = true
        let scheduledColdStart = schedulerEnabled
          ? yield* runIntrinsicCapacitySchedulerColdQuantum({
              sheet: input.request.sheet,
              preparedPieces: input.preparedPieces,
              ...(control === undefined ? {} : { control }),
              ...(input.options?.captureCapacityPhaseTimings === true
                ? { capturePhaseTimings: true }
                : {}),
              retentionMode: capacityRetentionMode
            }).pipe(Effect.mapError(mapIntrinsicCapacityError))
          : undefined
        let scheduledColdCheckpointReused = false
        if (scheduledColdStart !== undefined) {
          intrinsicAnytimeSchedulerTrace = {
            version: 'intrinsic-anytime-scheduler-v1',
            coldQuantumDepths: INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS,
            coldStartStatus: scheduledColdStart.status,
            coldStartCompletedDepths: scheduledColdStart.trace.completedDepths,
            coldStartConsumedPlacementEvaluations:
              scheduledColdStart.trace.consumedPlacementEvaluations,
            coldCheckpointReused: false,
            warmPrefixEndpointsAdmitted: false,
            cancellationReason: undefined,
            quanta: [
              {
                ordinal: 0,
                cohort: 'partial',
                producerRole: 'capacity-cold',
                outcome:
                  scheduledColdStart.status === 'paused' ? 'checkpointed' : 'settled'
              }
            ]
          }
        }
        const prefixSources: IntrinsicCapacityPrefixSource[] = []
        const archiveStartedAt = performance.now()
        const archive = yield* runIntrinsicSharedArchivePortfolio(
          input.request.sheet,
          input.preparedPieces,
          {
            maximumDirectRuntimeMs: 35_000,
            includeSourceAuditWitnesses: true,
            ...(schedulerEnabled
              ? {
                  canonicalGridCompletedPieceQuantum: 1,
                  onCanonicalGridCheckpointed: () =>
                    Effect.gen(function* () {
                      if (intrinsicAnytimeSchedulerTrace !== undefined) {
                        intrinsicAnytimeSchedulerTrace = {
                          ...intrinsicAnytimeSchedulerTrace,
                          quanta: [
                            ...intrinsicAnytimeSchedulerTrace.quanta,
                            {
                              ordinal: intrinsicAnytimeSchedulerTrace.quanta.length,
                              cohort: 'complete',
                              producerRole: 'legacy-complete',
                              outcome: 'checkpointed'
                            }
                          ]
                        }
                      }
                      const checkpoint = scheduledColdStart?.checkpoint
                      if (
                        scheduledColdStart?.status !== 'paused' ||
                        checkpoint === undefined
                      ) {
                        return
                      }
                      scheduledColdStart =
                        yield* runIntrinsicCapacitySchedulerColdQuantum({
                          sheet: input.request.sheet,
                          preparedPieces: input.preparedPieces,
                          checkpoint,
                          maximumDepthBoundaries: 1,
                          ...(control === undefined ? {} : { control }),
                          ...(input.options?.captureCapacityPhaseTimings === true
                            ? { capturePhaseTimings: true }
                            : {}),
                          retentionMode: capacityRetentionMode
                        })
                      scheduledColdCheckpointReused = true
                      if (intrinsicAnytimeSchedulerTrace !== undefined) {
                        intrinsicAnytimeSchedulerTrace = {
                          ...intrinsicAnytimeSchedulerTrace,
                          quanta: [
                            ...intrinsicAnytimeSchedulerTrace.quanta,
                            {
                              ordinal: intrinsicAnytimeSchedulerTrace.quanta.length,
                              cohort: 'partial',
                              producerRole: 'capacity-cold',
                              outcome:
                                scheduledColdStart.status === 'paused'
                                  ? 'checkpointed'
                                  : 'settled'
                            }
                          ]
                        }
                      }
                    })
                }
              : {}),
            ...(control === undefined ? {} : { control }),
            onDirectConstructed: (role, state) => {
              prefixSources.push({ role, state })
            },
            onPhaseCompleted: () =>
              emitSharedArchiveProgress(
                input,
                'shared_archive',
                undefined,
                performance.now() - coordinatorStartedAt
              ),
            periodic: {
              maximumCatalogRuntimeMs: 30_000,
              maximumContinuationRuntimeMs: 30_000,
              maximumTotalRuntimeMs: 240_000,
              maximumCellsPerFamilyRole: 16,
              maximumCropsPerCell: 4,
              sourceAuditScope: 'p2-axis-union'
            }
          }
        ).pipe(
          Effect.mapError((error) =>
            error._tag === 'IntrinsicStrictDecoderError'
              ? new IrregularPortfolioError({
                  operation: error.operation,
                  category: 'search',
                  message: error.message
                })
              : error._tag === 'IntrinsicCapacityError'
                ? mapIntrinsicCapacityError(error)
              : error
          )
        )
        if (!intrinsicSharedArchiveProductionValid(archive)) {
          const periodicCatalog = archive.periodicPortfolio.catalog
          return yield* Effect.fail(
            new IrregularPortfolioError({
              operation: 'intrinsicSharedArchive',
              category: 'search',
              message: [
                'intrinsic shared archive did not complete its production coverage contract',
                `direct=${archive.directRuns
                  .map(
                    ({ role, status, reason }) =>
                      `${role}:${status}${reason === undefined ? '' : `(${reason})`}`
                  )
                  .join(',')}`,
                `catalog-runtime=${periodicCatalog.runtimeCoverageComplete}`,
                `catalog-family=${periodicCatalog.familyCoverageComplete}`,
                `periodic-selection=${archive.periodicSelectionValid}`,
                `periodic=${archive.periodicRuns
                  .map(({ role, status }) => `${role}:${status}`)
                  .join(',')}`
              ].join('; ')
            })
          )
        }
        if (intrinsicAnytimeSchedulerTrace !== undefined) {
          intrinsicAnytimeSchedulerTrace = {
            ...intrinsicAnytimeSchedulerTrace,
            quanta: [
              ...intrinsicAnytimeSchedulerTrace.quanta,
              {
                ordinal: intrinsicAnytimeSchedulerTrace.quanta.length,
                cohort: 'complete',
                producerRole: 'legacy-complete',
                outcome: 'settled'
              }
            ]
          }
        }
        if (input.options?.captureExperimentalPlaceDeferCompleteShadow === true) {
          const experimental = yield* observeIntrinsicPlaceDeferCompleteShadow({
            sheet: input.request.sheet,
            preparedPieces: input.preparedPieces,
            ...(control === undefined ? {} : { control })
          })
          experimentalPlaceDeferTrace = experimental.trace
          input.options.onExperimentalPlaceDeferCompleteEndpoint?.(experimental.endpoint)
          if (intrinsicAnytimeSchedulerTrace !== undefined) {
            intrinsicAnytimeSchedulerTrace = {
              ...intrinsicAnytimeSchedulerTrace,
              quanta: [
                ...intrinsicAnytimeSchedulerTrace.quanta,
                {
                  ordinal: intrinsicAnytimeSchedulerTrace.quanta.length,
                  cohort: 'experimental-complete',
                  producerRole: 'experimental-place-defer-complete',
                  outcome:
                    experimental.trace.status === 'censored' ? 'censored' : 'settled'
                }
              ]
            }
          }
        }
        const protectedSheetlessArchive = retainRankedSharedArchive(
          archive.sheetlessArchive
        )
        const protectedSheetlessWinner =
          selectIntrinsicSharedArchiveWinner(protectedSheetlessArchive)
        const protectedFittingWinner = selectIntrinsicSharedArchiveWinner(
          selectFittingSharedArchive(protectedSheetlessArchive)
        )
        let focusedReconstructionEndpoints: ReadonlyArray<IntrinsicSharedArchiveEndpoint> =
          []
        if (focusedCompleteReconstructionEnabled) {
          if (
            protectedSheetlessWinner === undefined ||
            protectedFittingWinner === undefined
          ) {
            focusedCompleteReconstructionTrace = {
              version: 'intrinsic-focused-complete-reconstruction-v1',
              status: 'skipped-no-fitting-protected-endpoint',
              sourceCanonicalGeometryHash:
                protectedSheetlessWinner?.sheetlessCanonicalGeometryHash,
              candidateCanonicalGeometryHash: undefined,
              selectedCanonicalGeometryHash: undefined,
              consumedCandidateEvaluations: 0,
              candidateEvaluationAccountingComplete: true,
              runtimeMs: 0,
              outputInfluence: 'none',
              failureReason: undefined
            }
          } else {
            const reconstructionSeed: IntrinsicReconstructionSeed = {
              role: 'settled-protected',
              canonicalGeometryHash:
                protectedSheetlessWinner.sheetlessCanonicalGeometryHash,
              placedCollisionGeometries:
                protectedSheetlessWinner.placedCollisionGeometries,
              stepTrace: [],
              metrics: protectedSheetlessWinner.metrics
            }
            const reconstructionOutcome = yield* Effect.matchEffect(
              runIntrinsicReconstructionPortfolio({
                allPreparedPieces: input.preparedPieces,
                baselineSeeds: [reconstructionSeed],
                roleFamily: 'endpoint-q90-right-to-left',
                maximumRuntimeMsPerDecode: 15_000,
                maximumTotalRuntimeMs: 15_000,
                maximumCandidateEvaluationsPerDecode: 12_000,
                maximumTotalCandidateEvaluations: 12_000,
                ...(control === undefined ? {} : { control })
              }),
              {
                onFailure: (error) =>
                  error._tag === 'IrregularNfpIfpControlAbortError' &&
                  error.reason === 'cancelled'
                    ? Effect.fail(error)
                    : Effect.succeed({
                        kind: 'failed' as const,
                        error
                      }),
                onSuccess: (reconstruction) =>
                  Effect.succeed({
                    kind: 'completed' as const,
                    reconstruction
                  })
              }
            )
            if (reconstructionOutcome.kind === 'failed') {
              focusedCompleteReconstructionTrace = {
                version: 'intrinsic-focused-complete-reconstruction-v1',
                status: 'failed-protected-fallback',
                sourceCanonicalGeometryHash:
                  protectedSheetlessWinner.sheetlessCanonicalGeometryHash,
                candidateCanonicalGeometryHash: undefined,
                selectedCanonicalGeometryHash: undefined,
                consumedCandidateEvaluations: 0,
                candidateEvaluationAccountingComplete: false,
                runtimeMs: 0,
                outputInfluence: 'none',
                failureReason: `${reconstructionOutcome.error._tag}: ${reconstructionOutcome.error.message}`
              }
            } else {
              const reconstruction = reconstructionOutcome.reconstruction
              const focusedRun = reconstruction.runs.find(
                ({ role }) => role === 'endpoint-q90-right-to-left'
              )
              focusedReconstructionEndpoints =
                focusedRun?.status !== 'completed' ||
                focusedRun.metrics === undefined
                  ? []
                  : [
                      makeIntrinsicSharedArchiveEndpoint({
                        sheet: input.request.sheet,
                        role: `reconstruction-${focusedRun.role}`,
                        sourceId: focusedRun.sourceEndpointHash,
                        state: new IrregularBeamState({
                          remainingPreparedPieces: [],
                          placedCollisionGeometries:
                            focusedRun.placedCollisionGeometries,
                          unplacedPieceIds: [],
                          placementOrder:
                            focusedRun.placedCollisionGeometries.flatMap(
                              ({ placement }) => {
                                const pieceId =
                                  placement.pieceId ??
                                  placement.sourcePieceId
                                return pieceId === undefined ? [] : [pieceId]
                              }
                            )
                        }),
                        runtimeMs: focusedRun.runtimeMs
                      })
                    ].flatMap((endpoint) =>
                      endpoint === undefined ? [] : [endpoint]
                    )
              focusedCompleteReconstructionTrace = {
                version: 'intrinsic-focused-complete-reconstruction-v1',
                status: focusedRun?.status ?? 'incomplete',
                sourceCanonicalGeometryHash:
                  protectedSheetlessWinner.sheetlessCanonicalGeometryHash,
                candidateCanonicalGeometryHash:
                  focusedReconstructionEndpoints[0]
                    ?.sheetlessCanonicalGeometryHash,
                selectedCanonicalGeometryHash: undefined,
                consumedCandidateEvaluations:
                  reconstruction.consumedCandidateEvaluations,
                candidateEvaluationAccountingComplete:
                  reconstruction.candidateEvaluationAccountingComplete,
                runtimeMs: reconstruction.runtimeMs,
                outputInfluence: 'none',
                failureReason: undefined
              }
            }
          }
        }
        const sheetlessArchive = retainRankedSharedArchive([
          ...protectedSheetlessArchive,
          ...focusedReconstructionEndpoints
        ])
        settledCompleteArchiveForShortSideObserver = sheetlessArchive
        const winner = selectIntrinsicSharedArchiveWinner(
          selectFittingSharedArchive(sheetlessArchive)
        )
        if (focusedCompleteReconstructionTrace !== undefined) {
          focusedCompleteReconstructionTrace = {
            ...focusedCompleteReconstructionTrace,
            selectedCanonicalGeometryHash:
              winner?.sheetlessCanonicalGeometryHash,
            outputInfluence:
              winner === undefined
                ? 'none'
                : focusedReconstructionEndpoints.some(
                      ({ sheetlessCanonicalGeometryHash }) =>
                        sheetlessCanonicalGeometryHash ===
                        winner.sheetlessCanonicalGeometryHash
                    )
                  ? 'selected'
                  : 'protected-fallback'
          }
        }
        if (winner === undefined) {
          const capacity = yield* runIntrinsicCapacityMode({
            sheet: input.request.sheet,
            preparedPieces: input.preparedPieces,
            routing: 'bounded-complete-archive-miss',
            preflight,
            prefixSources,
            preflightRuntimeMs,
            completeArchiveRuntimeMs: Math.max(0, performance.now() - archiveStartedAt),
            ...capacityOptions,
            ...(scheduledColdStart === undefined
              ? {}
              : {
                  scheduledColdStart,
                  captureWarmPrefixTelemetry: true,
                  admitWarmPrefixEndpoints: true,
                  coordinateProtectedLanes: true
                }),
            ...(control === undefined ? {} : { control })
          }).pipe(Effect.mapError(mapIntrinsicCapacityError))
          if (intrinsicAnytimeSchedulerTrace !== undefined) {
            const capacityResumeOrdinal = intrinsicAnytimeSchedulerTrace.quanta.length
            const capacityQuanta = (capacity.trace.laneCoordinator?.quanta ?? [])
              .filter(
                ({ producerRole, phase, outcome }) =>
                  (producerRole === 'capacity-cold' && phase === 'resume') ||
                  (producerRole === 'capacity-warm-prefix' &&
                    (phase === 'initial' ||
                      phase === 'censor' ||
                      outcome === 'settled'))
              )
              .map(({ producerRole, outcome }, index) => ({
                ordinal: capacityResumeOrdinal + index,
                cohort: 'partial' as const,
                producerRole,
                outcome
              }))
            intrinsicAnytimeSchedulerTrace = {
              ...intrinsicAnytimeSchedulerTrace,
              coldCheckpointReused: scheduledColdCheckpointReused,
              warmPrefixEndpointsAdmitted: capacity.trace.warmPrefixEndpointsAdmitted,
              cancellationReason: 'complete-cohort-miss',
              quanta: [
                ...intrinsicAnytimeSchedulerTrace.quanta,
                ...capacityQuanta
              ]
            }
          }
          selected = yield* materializeIntrinsicCapacityResult(input, capacity)
          archiveDiagnostics.push(...intrinsicCapacityDiagnostics(preflight, capacity))
          yield* emitSharedArchiveProgress(
            input,
            'completed',
            selected.portfolio.score,
            performance.now() - coordinatorStartedAt
          )
        } else {
          if (intrinsicAnytimeSchedulerTrace !== undefined) {
            const capacityCancellation =
              scheduledColdCheckpointReused &&
              scheduledColdStart?.status === 'paused'
                ? [
                    {
                      ordinal: intrinsicAnytimeSchedulerTrace.quanta.length,
                      cohort: 'partial' as const,
                      producerRole: 'capacity-cold' as const,
                      outcome: 'cancelled' as const
                    }
                  ]
                : []
            intrinsicAnytimeSchedulerTrace = {
              ...intrinsicAnytimeSchedulerTrace,
              cancellationReason:
                scheduledColdStart === undefined
                  ? undefined
                  : 'complete-endpoint-fitted',
              quanta: [...intrinsicAnytimeSchedulerTrace.quanta, ...capacityCancellation]
            }
          }
          selected = yield* materializeSharedArchiveResult(input, winner)
          archiveDiagnostics.push(
            sharedArchiveDiagnostic(
              'completed',
              `shared archive selected ${winner.role} from ${sheetlessArchive.length} exact endpoints`
            ),
            new CollisionGeometryDiagnostic({
              code: 'capacity_preflight_inconclusive',
              message: 'proof-only capacity preflight was inconclusive; complete mode ran unchanged'
            }),
            new CollisionGeometryDiagnostic({
              code: 'complete_archive_fitted',
              message:
                scheduledColdStart === undefined
                  ? `complete endpoint ${winner.sheetlessCanonicalGeometryHash} fits the requested sheet; capacity mode did not run`
                  : `complete endpoint ${winner.sheetlessCanonicalGeometryHash} fits the requested sheet; scheduled capacity prework ${scheduledColdStart.status === 'paused' ? 'was cancelled at its checkpoint' : 'had already settled as observer-only work'}`
            })
          )
          yield* emitSharedArchiveProgress(
            input,
            'completed',
            selected.portfolio.score,
            performance.now() - coordinatorStartedAt
          )
        }
      }
    } else {
      const production = yield* runSingleSheetPortfolio(input, input.request.sheet, undefined)
      if (production.metrics !== undefined) input.options?.onPortfolioMetrics?.(production.metrics)
      selected = yield* materializeProductionResult(input, production)
    }

    if (
      settledCompleteArchiveForShortSideObserver !== undefined &&
      (shortSideProfileRequested ||
        input.options?.captureIntrinsicShortSideObserver === true ||
        input.options?.onIntrinsicShortSideObserver !== undefined)
    ) {
      if (shortSideProfileRequested) {
        yield* emitSharedArchiveProgress(
          input,
          'short_side_profile',
          selected.portfolio.score,
          performance.now() - coordinatorStartedAt
        )
      }
      intrinsicShortSideObserverTrace = observeIntrinsicShortSideOrientations({
        sheet: input.request.sheet,
        endpoints: settledCompleteArchiveForShortSideObserver,
        productionPlacedCollisionGeometries:
          selected.placedCollisionGeometries
      })
      input.options?.onIntrinsicShortSideObserver?.(intrinsicShortSideObserverTrace)
      const winnerHash =
        intrinsicShortSideObserverTrace.observerWinnerCanonicalGeometryHash
      const winnerRotation =
        intrinsicShortSideObserverTrace.observerWinnerRotationDeg
      const winnerEndpoint = settledCompleteArchiveForShortSideObserver.find(
        ({ sheetlessCanonicalGeometryHash }) =>
          sheetlessCanonicalGeometryHash === winnerHash
      )
      const winnerState =
        winnerEndpoint === undefined || winnerRotation === undefined
          ? undefined
          : new IrregularBeamState({
              remainingPreparedPieces: [],
              placedCollisionGeometries:
                winnerEndpoint.placedCollisionGeometries,
              placementOrder: winnerEndpoint.placedCollisionGeometries.map(
                ({ placement }) =>
                  placement.pieceId ?? placement.sourcePieceId
              )
            }).withQuarterTurnBottomLeft(winnerRotation)
      input.options?.onIntrinsicShortSideObserverWinner?.(
        winnerHash === undefined ||
          winnerRotation === undefined ||
          winnerState === undefined
          ? undefined
          : {
              canonicalGeometryHash: winnerHash,
              rotationDeg: winnerRotation,
              placedCollisionGeometries:
                winnerState.placedCollisionGeometries
            }
      )
      let shortSideSelected = false
      if (shortSideProfileRequested && winnerState !== undefined) {
        selected = yield* materializeIntrinsicShortSideProfileResult({
          input,
          placedCollisionGeometries: winnerState.placedCollisionGeometries,
          selection: 'archive-endpoint',
          canonicalGeometryHash: winnerHash
        })
        archiveDiagnostics.push(
          intrinsicShortSideProfileDiagnostic(
            'selected',
            `selected admitted complete archive endpoint ${winnerHash} at q${winnerRotation}`
          )
        )
        shortSideSelected = true
      }
      if (
        (shortSideProfileRequested ||
          input.options?.captureIntrinsicShortSidePairFoldObserver === true) &&
        !shortSideSelected &&
        intrinsicShortSideObserverTrace.observerWinnerCanonicalGeometryHash ===
          undefined &&
        intrinsicShortSideObserverTrace.productionShortAxisSpanMm !==
          undefined &&
        intrinsicShortSideObserverTrace.productionMaximumSideMm !==
          undefined &&
        intrinsicShortSideObserverTrace.productionEnvelopeAreaMm2 !==
          undefined &&
        intrinsicShortSideObserverTrace.productionShortAxisSpanGrid !==
          undefined &&
        intrinsicShortSideObserverTrace.productionMaximumSideGrid !==
          undefined &&
        intrinsicShortSideObserverTrace.productionEnvelopeAreaGrid2 !==
          undefined
      ) {
        const pairFoldOutcome = yield* observeIntrinsicShortSidePairFold({
          sheet: input.request.sheet,
          preparedPieces: input.preparedPieces,
          settings: input.settings,
          productionShortAxisSpanMm:
            intrinsicShortSideObserverTrace.productionShortAxisSpanMm,
          productionMaximumSideMm:
            intrinsicShortSideObserverTrace.productionMaximumSideMm,
          productionEnvelopeAreaMm2:
            intrinsicShortSideObserverTrace.productionEnvelopeAreaMm2,
          productionShortAxisSpanGrid:
            intrinsicShortSideObserverTrace.productionShortAxisSpanGrid,
          productionMaximumSideGrid:
            intrinsicShortSideObserverTrace.productionMaximumSideGrid,
          productionEnvelopeAreaGrid2:
            intrinsicShortSideObserverTrace.productionEnvelopeAreaGrid2
        })
        intrinsicShortSidePairFoldTrace = pairFoldOutcome.trace
        input.options?.onIntrinsicShortSidePairFoldObserverWinner?.(
          pairFoldOutcome.placedCollisionGeometries
        )
        if (
          shortSideProfileRequested &&
          pairFoldOutcome.trace.status === 'accepted' &&
          pairFoldOutcome.placedCollisionGeometries !== undefined
        ) {
          selected = yield* materializeIntrinsicShortSideProfileResult({
            input,
            placedCollisionGeometries: pairFoldOutcome.placedCollisionGeometries,
            selection: pairFoldOutcome.trace.constructionKind ?? 'pair-fold',
            canonicalGeometryHash: pairFoldOutcome.trace.canonicalGeometryHash
          })
          archiveDiagnostics.push(
            intrinsicShortSideProfileDiagnostic(
              'selected',
              `selected admitted ${pairFoldOutcome.trace.constructionKind ?? 'terminal'} construction ${pairFoldOutcome.trace.canonicalGeometryHash ?? 'without-canonical-hash'}`
            )
          )
          shortSideSelected = true
        }
      }
      if (shortSideProfileRequested && !shortSideSelected) {
        archiveDiagnostics.push(
          intrinsicShortSideProfileDiagnostic(
            'compact-fallback',
            `no admitted Short Side layout; retained Compact result (archive=${intrinsicShortSideObserverTrace.status}, terminal=${intrinsicShortSidePairFoldTrace?.status ?? 'not-run'})`
          )
        )
      }
    }
    for (const snapshot of selected.stateSnapshots) {
      input.options?.emitStateSnapshot?.(snapshot, input.settings.optimizer.beamWidth)
    }
    input.options?.onFinalizationMetrics?.(selected.finalizationMetrics)
    return {
      placedCollisionGeometries: selected.placedCollisionGeometries,
      score: selected.score,
      unplacedPieceIds: selected.unplacedPieceIds,
      diagnostics: [
        ...input.diagnostics,
        ...selected.score.freeMaterialSnapshot.diagnostics,
        ...archiveDiagnostics
      ],
      sortedPieceIds: input.sortedPieceIds,
      stateSnapshots: selected.stateSnapshots,
      beamWidth: input.settings.optimizer.beamWidth,
      portfolio: selected.portfolio,
      ...(selected.capacityTrace === undefined ? {} : { capacityTrace: selected.capacityTrace }),
      ...(capacityShadowTelemetry === undefined ? {} : { capacityShadowTelemetry }),
      ...(intrinsicAnytimeSchedulerTrace === undefined
        ? {}
        : { intrinsicAnytimeSchedulerTrace }),
      ...(experimentalPlaceDeferTrace === undefined
        ? {}
        : { experimentalPlaceDeferTrace }),
      ...(focusedCompleteReconstructionTrace === undefined
        ? {}
        : { focusedCompleteReconstructionTrace }),
      ...(intrinsicShortSideObserverTrace === undefined
        ? {}
        : { intrinsicShortSideObserverTrace }),
      ...(intrinsicShortSidePairFoldTrace === undefined
        ? {}
        : { intrinsicShortSidePairFoldTrace })
    }
  })
}

function mapIntrinsicCapacityError(
  error: IrregularComputeErrorType | IntrinsicCapacityError
): IrregularComputeErrorType {
  return error._tag === 'IntrinsicCapacityError'
    ? new IrregularPortfolioError({
        operation: error.operation,
        category: 'search',
        message: error.message
      })
    : error
}

/** Adapts one settled exact capacity endpoint into the common compute result. */
function materializeIntrinsicCapacityResult(
  input: IrregularSearchCoordinatorInput,
  capacity: IntrinsicCapacityModeResult
): Effect.Effect<MaterializedDecode, IrregularComputeErrorType> {
  return Effect.gen(function* () {
    const endpoint = capacity.endpoint
    const placedCollisionGeometries = endpoint.placedCollisionGeometries
    const state = new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries,
      unplacedPieceIds: endpoint.unplacedPreparedIds,
      placementOrder: endpoint.placedPreparedIds
    })
    const scoringStartedAt =
      input.options?.onFinalizationMetrics === undefined ? 0 : performance.now()
    const score = yield* input.layoutScorer.scoreState({
      sheet: input.request.sheet,
      state
    })
    const stateSnapshots =
      input.request.options.historyMode === 'off'
        ? []
        : selectedLayoutRevealSnapshots(
            input.preparedPieces,
            placedCollisionGeometries,
            endpoint.unplacedPreparedIds
          )
    const portfolio = new IrregularPortfolioResult({
      status: 'completed',
      terminationReason: 'capacity_subset_settled',
      source: 'shared-archive',
      placements: placedCollisionGeometries.map(({ placement }) => placement),
      unplacedPieceIds: endpoint.unplacedPreparedIds,
      score: layoutScoreSummary(score, endpoint.metrics.enclosedCavityCount),
      diagnostics: [
        new CollisionGeometryDiagnostic({
          code: 'capacity_subset_settled',
          message: [
            `intrinsic-capacity-v1 settled ${endpoint.metrics.placedCount} placed`,
            `${endpoint.unplacedPreparedIds.length} unplaced`,
            `origin ${endpoint.origin}`,
            `q${endpoint.selectedRotationDeg}`,
            `hash ${endpoint.canonicalGeometryHash}`
          ].join('; ')
        })
      ]
    })
    return {
      placedCollisionGeometries,
      score,
      unplacedPieceIds: endpoint.unplacedPreparedIds,
      diagnostics: [],
      sortedPieceIds: input.sortedPieceIds,
      stateSnapshots,
      beamWidth: input.settings.optimizer.beamWidth,
      portfolio,
      capacityTrace: capacity.trace,
      finalizationMetrics: {
        reconstructionElapsedMs: 0,
        finalScoreElapsedMs:
          input.options?.onFinalizationMetrics === undefined
            ? 0
            : Math.max(0, performance.now() - scoringStartedAt)
      }
    }
  })
}

/** Bounded capacity trace summary in the additive diagnostics vocabulary. */
function intrinsicCapacityDiagnostics(
  preflight: IntrinsicCapacityPreflightOutcome,
  capacity: IntrinsicCapacityModeResult
): ReadonlyArray<CollisionGeometryDiagnostic> {
  const diagnostics: CollisionGeometryDiagnostic[] = []
  if (preflight.kind === 'proven_impossible') {
    diagnostics.push(
      new CollisionGeometryDiagnostic({
        code: 'capacity_preflight_proven_impossible',
        message: [
          `reason ${preflight.reason}`,
          `minimum-doubled-collision-area-grid2 ${String(
            preflight.measurements.minimumDoubledCollisionAreaSumGrid2
          )}`,
          `sheet-doubled-area-grid2 ${String(preflight.measurements.sheetDoubledAreaGrid2)}`,
          ...(preflight.reason === 'singleton-transform-set-does-not-fit'
            ? [`piece ${preflight.pieceId}`]
            : [])
        ].join('; ')
      })
    )
  } else {
    diagnostics.push(
      new CollisionGeometryDiagnostic({
        code: 'capacity_preflight_inconclusive',
        message: 'proof-only capacity preflight was inconclusive; complete mode ran unchanged'
      }),
      new CollisionGeometryDiagnostic({
        code: 'bounded_complete_archive_miss',
        message:
          'valid, uncensored bounded complete archive produced no fitting endpoint; this is a bounded-search outcome, not an impossibility proof'
      })
    )
  }
  const trace = capacity.trace
  diagnostics.push(
    new CollisionGeometryDiagnostic({
      code: 'capacity_subset_settled',
      message: [
        `settlement ${trace.coldSearch.settlement}`,
        `placed ${trace.selected.placedCount}`,
        `unplaced ${trace.selected.unplacedCount}`,
        `origin ${trace.selected.origin}`,
        `evaluations ${trace.coldSearch.consumedPlacementEvaluations}/${trace.coldSearch.placementEvaluationCap}`,
        `pruned-count ${trace.coldSearch.prunedByAttainableCount}`,
        `pruned-material ${trace.coldSearch.prunedByAttainableMaterial}`,
        `prefixes ${trace.prefixes.fittingCount}/${trace.prefixes.capturedCount}`,
        `hash ${trace.selected.canonicalGeometryHash}`
      ].join('; ')
    })
  )
  return diagnostics
}

function runSingleSheetPortfolio(
  input: IrregularSearchCoordinatorInput,
  sheet: SheetSpec,
  decodeRole: 'production' | 'canonical-reference' | undefined
): Effect.Effect<SingleSheetDecode, IrregularComputeErrorType> {
  return Effect.gen(function* () {
    const stateSnapshots: IrregularStateSnapshot[] = []
    let terminalState: IrregularBeamState | undefined
    let metrics: IrregularPortfolioMetrics | undefined
    const instrumentation =
      input.options?.onPortfolioPhase === undefined &&
      input.options?.onPortfolioMetrics === undefined
        ? undefined
        : {
            ...(input.options?.onPortfolioPhase !== undefined
              ? { onPhase: input.options.onPortfolioPhase }
              : {}),
            ...(input.options?.onPortfolioMetrics !== undefined
              ? {
                  onMetrics: (nextMetrics: IrregularPortfolioMetrics) => {
                    metrics = nextMetrics
                  }
                }
              : {})
          }
    const portfolioInput = {
      sheet,
      pieces: input.preparedPieces,
      ...(input.request.options.historyMode !== 'off'
        ? {
            onStateSnapshot: (snapshot: IrregularStateSnapshot) => {
              stateSnapshots.push({
                ...snapshot,
                stepIndex:
                  input.preparedPieces.length - snapshot.state.remainingPreparedPieces.length
              })
            }
          }
        : {}),
      onSelectedState: (state: IrregularBeamState) => {
        terminalState = state
      },
      ...(input.options?.emitPortfolioProgress !== undefined
        ? {
            onProgress: (progress: IrregularPortfolioProgress) =>
              input.options?.emitPortfolioProgress?.(
                portfolioProgressForDecodeRole(progress, decodeRole)
              ) ?? Effect.void
          }
        : {}),
      ...(input.request.options.historyMode !== 'off' &&
      input.options?.emitDecisionTrace !== undefined
        ? { emitDecisionTrace: input.options.emitDecisionTrace }
        : {}),
      ...(decodeRole !== undefined ? { decisionTraceDecodeIdPrefix: `${decodeRole}:` } : {}),
      ...(input.options?.isCancelled !== undefined
        ? { isCancelled: input.options.isCancelled }
        : {}),
      ...(instrumentation !== undefined ? { instrumentation } : {})
    }
    const portfolio = yield* input.portfolioService.run(portfolioInput)
    return { sheet, portfolio, terminalState, stateSnapshots, metrics }
  })
}

function emitSharedArchiveProgress(
  input: IrregularSearchCoordinatorInput,
  phase: 'shared_archive' | 'short_side_profile' | 'completed',
  bestScore: IrregularLayoutScoreSummary | undefined,
  elapsedMs: number
): Effect.Effect<void> {
  return (
    input.options?.emitPortfolioProgress?.(
      new IrregularPortfolioProgress({
        phase,
        ...(bestScore === undefined ? {} : { bestScore }),
        elapsedMs: Math.max(0, elapsedMs)
      })
    ) ?? Effect.void
  )
}

export function portfolioProgressForDecodeRole(
  progress: IrregularPortfolioProgress,
  decodeRole: 'production' | 'canonical-reference' | undefined
): IrregularPortfolioProgress {
  return decodeRole === undefined
    ? progress
    : new IrregularPortfolioProgress({ ...progress, decodeRole })
}

interface MaterializedDecode extends IrregularComputeResult {
  readonly finalizationMetrics: IrregularFinalizationMetrics
}

function materializeProductionResult(
  input: IrregularSearchCoordinatorInput,
  decoded: SingleSheetDecode
): Effect.Effect<MaterializedDecode, IrregularComputeErrorType> {
  return Effect.gen(function* () {
    const reconstructionStartedAt =
      input.options?.onFinalizationMetrics === undefined ? 0 : performance.now()
    const placedCollisionGeometries = yield* reconstructPlacedGeometry(
      decoded.portfolio,
      input.preparedPieces,
      input.geometryKernel
    )
    const reconstructionElapsedMs =
      input.options?.onFinalizationMetrics === undefined
        ? 0
        : Math.max(0, performance.now() - reconstructionStartedAt)
    const reconstructedState = new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries,
      unplacedPieceIds: decoded.portfolio.unplacedPieceIds,
      placementOrder: placedCollisionGeometries.map(
        ({ placement }) => placement.pieceId ?? placement.sourcePieceId
      )
    })
    const scoringStartedAt =
      input.options?.onFinalizationMetrics === undefined ? 0 : performance.now()
    const reconstructedScore = yield* input.layoutScorer.scoreState({
      sheet: input.request.sheet,
      state: reconstructedState
    })
    const score = preservePortfolioContactMetrics(reconstructedScore, decoded.portfolio.score)
    return {
      placedCollisionGeometries,
      score,
      unplacedPieceIds: decoded.portfolio.unplacedPieceIds,
      diagnostics: [],
      sortedPieceIds: input.sortedPieceIds,
      stateSnapshots: decoded.stateSnapshots,
      beamWidth: input.settings.optimizer.beamWidth,
      portfolio: decoded.portfolio,
      finalizationMetrics: {
        reconstructionElapsedMs,
        finalScoreElapsedMs:
          input.options?.onFinalizationMetrics === undefined
            ? 0
            : Math.max(0, performance.now() - scoringStartedAt)
      }
    }
  })
}

function materializeSharedArchiveResult(
  input: IrregularSearchCoordinatorInput,
  endpoint: IntrinsicSharedArchiveEndpoint
): Effect.Effect<MaterializedDecode, IrregularComputeErrorType> {
  return Effect.gen(function* () {
    const placedCollisionGeometries = endpoint.requestedSheetFit.selectedPlacedCollisionGeometries
    const state = new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries,
      placementOrder: placedCollisionGeometries.map(
        ({ placement }) => placement.pieceId ?? placement.sourcePieceId
      )
    })
    const scoringStartedAt =
      input.options?.onFinalizationMetrics === undefined ? 0 : performance.now()
    const reconstructedScore = yield* input.layoutScorer.scoreState({
      sheet: input.request.sheet,
      state
    })
    const score = preserveSharedArchiveExactMetrics(reconstructedScore, endpoint)
    const stateSnapshots =
      input.request.options.historyMode === 'off'
        ? []
        : selectedLayoutRevealSnapshots(input.preparedPieces, placedCollisionGeometries)
    const portfolio = new IrregularPortfolioResult({
      status: 'completed',
      terminationReason: 'shared_archive_completed',
      source: 'shared-archive',
      placements: placedCollisionGeometries.map(({ placement }) => placement),
      unplacedPieceIds: [],
      score: layoutScoreSummary(score, endpoint.metrics.enclosedCavityCount),
      diagnostics: [
        sharedArchiveDiagnostic(
          'selected',
          `selected exact shared-archive role ${endpoint.role} (${endpoint.sheetlessCanonicalGeometryHash})`
        )
      ]
    })
    return {
      placedCollisionGeometries,
      score,
      unplacedPieceIds: [],
      diagnostics: [],
      sortedPieceIds: input.sortedPieceIds,
      stateSnapshots,
      beamWidth: input.settings.optimizer.beamWidth,
      portfolio,
      finalizationMetrics: {
        reconstructionElapsedMs: 0,
        finalScoreElapsedMs:
          input.options?.onFinalizationMetrics === undefined
            ? 0
            : Math.max(0, performance.now() - scoringStartedAt)
      }
    }
  })
}

/** Materializes one already-admitted Short Side layout through the normal result path. */
function materializeIntrinsicShortSideProfileResult(input: {
  readonly input: IrregularSearchCoordinatorInput
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly selection: 'archive-endpoint' | IntrinsicShortSideConstructionKind
  readonly canonicalGeometryHash: string | undefined
}): Effect.Effect<MaterializedDecode, IrregularComputeErrorType> {
  return Effect.gen(function* () {
    const state = new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries: input.placedCollisionGeometries,
      placementOrder: input.placedCollisionGeometries.map(
        ({ placement }) => placement.pieceId ?? placement.sourcePieceId
      )
    })
    const scoringStartedAt =
      input.input.options?.onFinalizationMetrics === undefined ? 0 : performance.now()
    const score = yield* input.input.layoutScorer.scoreState({
      sheet: input.input.request.sheet,
      state
    })
    const stateSnapshots =
      input.input.request.options.historyMode === 'off'
        ? []
        : selectedLayoutRevealSnapshots(input.input.preparedPieces, input.placedCollisionGeometries)
    const selectionDescription =
      input.selection === 'archive-endpoint'
        ? 'settled archive endpoint'
        : `terminal ${input.selection} construction`
    const portfolio = new IrregularPortfolioResult({
      status: 'completed',
      terminationReason: 'shared_archive_completed',
      source: 'shared-archive',
      placements: input.placedCollisionGeometries.map(({ placement }) => placement),
      unplacedPieceIds: [],
      score: layoutScoreSummary(score),
      diagnostics: [
        intrinsicShortSideProfileDiagnostic(
          'selected',
          `selected ${selectionDescription}${input.canonicalGeometryHash === undefined ? '' : ` (${input.canonicalGeometryHash})`}`
        )
      ]
    })
    return {
      placedCollisionGeometries: input.placedCollisionGeometries,
      score,
      unplacedPieceIds: [],
      diagnostics: [],
      sortedPieceIds: input.input.sortedPieceIds,
      stateSnapshots,
      beamWidth: input.input.settings.optimizer.beamWidth,
      portfolio,
      finalizationMetrics: {
        reconstructionElapsedMs: 0,
        finalScoreElapsedMs:
          input.input.options?.onFinalizationMetrics === undefined
            ? 0
            : Math.max(0, performance.now() - scoringStartedAt)
      }
    }
  })
}

/** Builds a truthful scrub sequence from prefixes of the selected exact layout. */
function selectedLayoutRevealSnapshots(
  preparedPieces: ReadonlyArray<IrregularPreparedPiece>,
  placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>,
  unplacedPieceIds: ReadonlyArray<PieceId> = []
): ReadonlyArray<IrregularStateSnapshot> {
  const preparedById = new Map(
    preparedPieces.map((piece) => [piece.pieceId ?? piece.source.id, piece] as const)
  )

  return Array.from({ length: placedCollisionGeometries.length + 1 }, (_, stepIndex) => {
    const placed = placedCollisionGeometries.slice(0, stepIndex)
    const remainingPreparedPieces = placedCollisionGeometries
      .slice(stepIndex)
      .flatMap(({ placement }) => {
        const piece = preparedById.get(placement.pieceId ?? placement.sourcePieceId)
        return piece === undefined ? [] : [piece]
      })

    return {
      stepIndex,
      beamRank: 0,
      candidateCount: 1,
      source: 'shared-archive' as const,
      state: new IrregularBeamState({
        remainingPreparedPieces,
        placedCollisionGeometries: placed,
        unplacedPieceIds,
        placementOrder: placed.map(
          ({ placement }) => placement.pieceId ?? placement.sourcePieceId
        )
      })
    }
  })
}

/** Explicit activation boundary for the production shared archive. */
export function isIntrinsicSharedArchiveEligible(settings: IrregularNestingSettings): boolean {
  return intrinsicSharedArchiveEligibility(settings.optimizer).eligible
}

function layoutScoreSummary(
  score: IrregularLayoutScore,
  canonicalEnclosedCavityCount?: number
): IrregularLayoutScoreSummary {
  return new IrregularLayoutScoreSummary({
    ...layoutScoreSummaryFields(score),
    ...(canonicalEnclosedCavityCount === undefined ? {} : { canonicalEnclosedCavityCount })
  })
}

function layoutScoreSummaryFields(score: IrregularLayoutScore) {
  return {
    unplacedCount: score.unplacedCount,
    sharedCollisionBoundaryLengthMm: score.sharedCollisionBoundaryLengthMm,
    sharedCollisionBoundaryContactUnits: score.sharedCollisionBoundaryContactUnits,
    sharedCollisionBoundaryContactBand: score.sharedCollisionBoundaryContactBand,
    nearCompleteStructuralContactCount: score.nearCompleteStructuralContactCount,
    dominantNearCompleteStructuralContactCount: score.dominantNearCompleteStructuralContactCount,
    largestNetFreeMaterialRegionAreaMm2: score.largestNetFreeMaterialRegionAreaMm2,
    freeMaterialRegionCount: score.freeMaterialRegionCount,
    freeMaterialHoleCount: score.freeMaterialHoleCount,
    freeMaterialSliverMetric: score.freeMaterialSliverMetric,
    collisionBoundsWorstNormalizedSheetConsumption:
      score.collisionBoundsWorstNormalizedSheetConsumption,
    collisionBoundsNormalizedSpanSum: score.collisionBoundsNormalizedSpanSum,
    collisionBoundsAreaMm2: score.collisionBoundsAreaMm2,
    collisionBoundsSpanMm: score.collisionBoundsSpanMm
  }
}

function sharedArchiveDiagnostic(
  status: 'completed' | 'selected',
  message: string
): CollisionGeometryDiagnostic {
  return new CollisionGeometryDiagnostic({
    code: `intrinsic_shared_archive_${status}`,
    message
  })
}

/** Adds a truthful terminal-profile status to the ordinary worker diagnostics. */
function intrinsicShortSideProfileDiagnostic(
  status: 'selected' | 'compact-fallback',
  message: string
): CollisionGeometryDiagnostic {
  return new CollisionGeometryDiagnostic({
    code: `intrinsic_short_side_${status}`,
    message
  })
}

/**
 * Preserves contact metrics measured on the selected search geometry.
 *
 * Final reconstruction intentionally rebuilds each source polygon at its
 * absolute terminal transform. Reapplying a uniform bottom-left translation
 * can change floating-point cancellation, while evaluating a derived angle
 * after a rigid quarter-turn can produce a numerically different but
 * geometrically equivalent polygon. Exact collinearity must therefore remain
 * authoritative from the selected beam state, while bounds and free-material
 * diagnostics still come from the public reconstructed geometry.
 */
export function preservePortfolioContactMetrics(
  reconstructed: IrregularLayoutScore,
  portfolio: IrregularLayoutScoreSummary | undefined
): IrregularLayoutScore {
  if (
    portfolio?.sharedCollisionBoundaryLengthMm === undefined ||
    portfolio.sharedCollisionBoundaryContactUnits === undefined ||
    portfolio.sharedCollisionBoundaryContactBand === undefined ||
    portfolio.nearCompleteStructuralContactCount === undefined ||
    portfolio.dominantNearCompleteStructuralContactCount === undefined
  ) {
    return reconstructed
  }

  return {
    ...reconstructed,
    sharedCollisionBoundaryLengthMm: portfolio.sharedCollisionBoundaryLengthMm,
    sharedCollisionBoundaryContactUnits: portfolio.sharedCollisionBoundaryContactUnits,
    sharedCollisionBoundaryContactBand: portfolio.sharedCollisionBoundaryContactBand,
    nearCompleteStructuralContactCount: portfolio.nearCompleteStructuralContactCount,
    dominantNearCompleteStructuralContactCount: portfolio.dominantNearCompleteStructuralContactCount
  }
}

/** Preserves canonical-grid topology and contact metrics from the selected archive endpoint. */
export function preserveSharedArchiveExactMetrics(
  reconstructed: IrregularLayoutScore,
  endpoint: IntrinsicSharedArchiveEndpoint
): IrregularLayoutScore {
  return {
    ...reconstructed,
    sharedCollisionBoundaryLengthMm: endpoint.metrics.sharedBoundaryLengthMm,
    sharedCollisionBoundaryContactUnits: endpoint.metrics.contactUnits,
    sharedCollisionBoundaryContactBand: Math.floor(endpoint.metrics.contactUnits),
    nearCompleteStructuralContactCount: endpoint.metrics.totalStructuralContacts,
    dominantNearCompleteStructuralContactCount: endpoint.metrics.dominantStructuralContacts,
    occupiedHullWasteRatio: endpoint.metrics.occupiedHullWasteRatio
  }
}

function reconstructPlacedGeometry(
  portfolio: IrregularPortfolioResult,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  geometryKernel: import('../../irregular/geometryKernel.js').GeometryKernel.Service
): Effect.Effect<
  ReadonlyArray<IrregularPlacedPiece>,
  IrregularComputeError | IrregularGeometryInputError | IrregularNestingNotImplementedError
> {
  return Effect.forEach(
    portfolio.placements,
    (
      placement
    ): Effect.Effect<
      IrregularPlacedPiece,
      IrregularComputeError | IrregularGeometryInputError | IrregularNestingNotImplementedError
    > => {
      const prepared = pieces.find(
        (piece) =>
          (piece.pieceId ?? piece.source.id) === (placement.pieceId ?? placement.sourcePieceId) &&
          piece.source.id === placement.sourcePieceId
      )
      if (prepared === undefined) {
        return Effect.fail(
          new IrregularComputeError({
            preparedPieceId: placement.pieceId ?? placement.sourcePieceId,
            sourcePieceId: placement.sourcePieceId,
            message: `Portfolio placement ${placement.sourcePieceId} has no prepared piece.`
          })
        )
      }
      const transform = resolvePortfolioPlacementTransform({
        transforms: prepared.transforms,
        rotationDeg: placement.transform.rotationDeg,
        mirrored: placement.transform.mirrored
      })
      if (transform === undefined) {
        return Effect.fail(
          new IrregularGeometryInputError({
            operation: 'reconstructPortfolioPlacement',
            message: `Portfolio placement ${placement.sourcePieceId} has no matching transform candidate.`
          })
        )
      }
      return geometryKernel
        .transformCollisionGeometry({
          geometry: prepared.collisionGeometry,
          transform
        })
        .pipe(
          Effect.map(
            (collisionGeometry) => new IrregularPlacedPiece({ placement, collisionGeometry })
          )
        )
    },
    { concurrency: 1 }
  )
}

/**
 * Resolves a selected placement to geometry that can be reconstructed from the
 * prepared finite transform set.
 *
 * Terminal orientation may rigidly quarter-turn a completed legal layout after
 * search. Such an absolute angle does not need to consume one of the capped
 * per-piece search transforms, but it must remain a quarter-turn of one that
 * was actually prepared.
 */
export function resolvePortfolioPlacementTransform(input: {
  readonly transforms: ReadonlyArray<IrregularTransformCandidate>
  readonly rotationDeg: number
  readonly mirrored: boolean
}): IrregularTransformCandidate | undefined {
  const sameMirrorTransforms = input.transforms
    .filter((candidate) => candidate.mirrored === input.mirrored)
    .toSorted((first, second) => first.index - second.index)
  const exact = sameMirrorTransforms.find(
    (candidate) => candidate.rotationDeg === input.rotationDeg
  )
  if (exact !== undefined) return exact

  const quarterTurnBase = sameMirrorTransforms.find((candidate) =>
    isQuarterTurnEquivalent(candidate.rotationDeg, input.rotationDeg)
  )
  if (quarterTurnBase === undefined) return undefined

  return new IrregularTransformCandidate({
    index: quarterTurnBase.index,
    rotationDeg: input.rotationDeg,
    mirrored: input.mirrored,
    reason: quarterTurnBase.reason
  })
}

function isQuarterTurnEquivalent(firstRotationDeg: number, secondRotationDeg: number): boolean {
  const normalizedDifference = normalizeRotationDegrees(secondRotationDeg - firstRotationDeg)
  return [0, 90, 180, 270].some(
    (quarterTurnDeg) => Math.abs(normalizedDifference - quarterTurnDeg) <= 1e-9
  )
}

function normalizeRotationDegrees(rotationDeg: number): number {
  const remainder = rotationDeg % 360
  return remainder < 0 ? remainder + 360 : remainder
}

function findSourcePiece(
  sourcePieceId: PieceId,
  preparedPieceId: PieceId,
  sourcePieces: ReadonlyArray<ImportedPiece>
): ImportedPiece | undefined {
  const direct = sourcePieces.find(
    (source) => source.id === sourcePieceId || source.id === preparedPieceId
  )
  if (direct !== undefined) return direct

  const baseId = sourcePieceId.replace(/-copy-\d+$/, '')
  const preparedBaseId = preparedPieceId.replace(/-copy-\d+$/, '')
  const base = sourcePieces.find((source) => source.id === baseId || source.id === preparedBaseId)
  return base
}
