import { Effect } from 'effect'
import { performance } from 'node:perf_hooks'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type { IrregularPreparedPiece } from '@shared/irregular/domain.js'
import type { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import type {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError,
  IrregularNfpIfpControl,
  IrregularNfpIfpControlAbortError,
  NfpIfpService
} from '../../irregular/services.js'
import {
  compareIntrinsicCapacityEndpoints,
  intrinsicCapacityEndpointPartitionsRequest,
  intrinsicCapacityObjective,
  materializeIntrinsicCapacityEndpoint,
  type IntrinsicCapacityCavityCache,
  type IntrinsicCapacityEndpoint,
  type IntrinsicCapacityObjective
} from './intrinsicCapacityEndpoint.js'
import { retainIntrinsicAnytimeArchiveNamespace } from './intrinsicAnytimeArchive.js'
import {
  intrinsicCapacityMaterialAreas,
  intrinsicCapacityPreparedPieceId
} from './intrinsicCapacityMaterial.js'
import {
  IntrinsicCapacityError,
  type IntrinsicCapacityPreflightOutcome
} from './intrinsicCapacityPreflight.js'
import {
  captureIntrinsicCapacityPrefixDescriptors,
  terminalizeIntrinsicCapacityPrefixEndpoints,
  type IntrinsicCapacityPrefixDescriptor,
  type IntrinsicCapacityPrefixSource
} from './intrinsicCapacityPrefixes.js'
import {
  INTRINSIC_CAPACITY_V1_BOUNDS,
  materializeIntrinsicCapacityCheckpointEndpoints,
  runIntrinsicCapacityColdSearch,
  type IntrinsicAnytimeCheckpoint,
  type IntrinsicCapacityRetentionMode,
  type IntrinsicCapacitySearchResult,
  type IntrinsicCapacitySearchPhaseTimings,
  type IntrinsicCapacitySearchTrace,
  type IntrinsicCapacityTopologyRetentionDepthTrace,
  type IntrinsicCapacityWarmPrefixSeed
} from './intrinsicCapacitySearch.js'
import { IrregularBeamState } from './irregularBeamState.js'

export type IntrinsicCapacityRouting =
  | 'preflight-proven-impossible'
  | 'bounded-complete-archive-miss'

export interface IntrinsicCapacityPrefixTrace {
  readonly capturedCount: number
  readonly fittingCount: number
  readonly rejectedCount: number
  readonly terminalizedCount: number
  readonly descriptors: ReadonlyArray<{
    readonly role: string
    readonly depth: number
  }>
}

export interface IntrinsicCapacityIncumbentTrace {
  readonly sourceRole: string | undefined
  readonly prefixDepth: number | undefined
  readonly placedCount: number
  readonly placedMaterialAreaMm2: number
  readonly selectedRotationDeg: 0 | 90
  readonly canonicalGeometryHash: string
}

export interface IntrinsicCapacitySelectionTrace extends IntrinsicCapacityObjective {
  readonly unplacedCount: number
  readonly placedMaterialAreaMm2: number
  readonly selectedRotationDeg: 0 | 90
}

export interface IntrinsicCapacityWarmPrefixLaneTrace {
  readonly sourceRole: string
  readonly prefixDepth: number
  readonly reusedPlacedCount: number
  readonly status: 'settled' | 'checkpointed-censored'
  readonly selectedForContinuation: boolean
  readonly checkpointRetained: boolean
  readonly consumedPlacementEvaluations: number
  readonly completedDepths: number
  readonly elapsedMs: number
  readonly endpoint: IntrinsicCapacityObjective | undefined
}

export interface IntrinsicCapacityCohesionShadowTrace {
  readonly producerRole: 'capacity-cohesion-shadow'
  readonly status: 'settled'
  readonly outputInfluence: 'none'
  readonly consumedPlacementEvaluations: number
  readonly completedDepths: number
  readonly elapsedMs: number
  readonly endpoint: IntrinsicCapacityObjective | undefined
  readonly retentionDepths:
    | ReadonlyArray<IntrinsicCapacityTopologyRetentionDepthTrace>
    | undefined
}

export interface IntrinsicCapacityLaneCoordinatorTrace {
  readonly version: 'intrinsic-capacity-lane-coordinator-v2'
  readonly aggregatePlacementEvaluationCap: number
  readonly aggregateConsumedPlacementEvaluations: number
  readonly warmPilotDepthBoundaries: number
  readonly continuedProducers: ReadonlyArray<
    | {
        readonly role: 'capacity-cold'
      }
    | {
        readonly role: 'capacity-warm-prefix'
        readonly sourceRole: string
        readonly prefixDepth: number
      }
  >
  readonly retainedCheckpointCount: number
  readonly censoredLaneCount: number
  readonly quanta: ReadonlyArray<{
    readonly ordinal: number
    readonly producerRole: 'capacity-cold' | 'capacity-warm-prefix'
    readonly sourceRole: string | undefined
    readonly prefixDepth: number | undefined
    readonly phase: 'initial' | 'resume' | 'censor'
    readonly fromDepth: number
    readonly toDepth: number
    readonly placementEvaluationDelta: number
    readonly outcome: 'checkpointed' | 'settled' | 'censored'
  }>
}

type IntrinsicCapacityContinuedProducer =
  IntrinsicCapacityLaneCoordinatorTrace['continuedProducers'][number]
type IntrinsicCapacityLaneCoordinatorQuantum =
  IntrinsicCapacityLaneCoordinatorTrace['quanta'][number]

export interface IntrinsicCapacityTrace {
  readonly routing: IntrinsicCapacityRouting
  readonly preflight: IntrinsicCapacityPreflightOutcome
  readonly prefixes: IntrinsicCapacityPrefixTrace
  readonly prefixIncumbent: IntrinsicCapacityIncumbentTrace | undefined
  readonly coldSearch: IntrinsicCapacitySearchTrace
  /** Observer-only independent warm lanes; excluded from final selection. */
  readonly warmPrefixLanes: ReadonlyArray<IntrinsicCapacityWarmPrefixLaneTrace> | undefined
  readonly warmPrefixEndpointsAdmitted: boolean
  readonly cohesionShadow: IntrinsicCapacityCohesionShadowTrace | undefined
  readonly laneCoordinator: IntrinsicCapacityLaneCoordinatorTrace | undefined
  readonly selected: IntrinsicCapacitySelectionTrace
  /** Coordinator-measured proof-only preflight runtime. */
  readonly preflightRuntimeMs: number | undefined
  /** Coordinator-measured unchanged complete archive runtime before the miss. */
  readonly completeArchiveRuntimeMs: number | undefined
  /** Descriptor capture plus prefix terminalization runtime. */
  readonly prefixTerminalizationMs: number
  /** Cold subset search runtime including endpoint materialization. */
  readonly coldSearchMs: number
  readonly runtimeMs: number
}

/** Verifies exact coordinator chronology and per-lane evaluation accounting. */
export function intrinsicCapacityLaneCoordinatorTraceValid(
  trace: IntrinsicCapacityLaneCoordinatorTrace,
  warmLanes: ReadonlyArray<IntrinsicCapacityWarmPrefixLaneTrace>
): boolean {
  if (
    trace.aggregateConsumedPlacementEvaluations >
      trace.aggregatePlacementEvaluationCap ||
    trace.quanta.some(
      (quantum, index) =>
        quantum.ordinal !== index ||
        !Number.isInteger(quantum.fromDepth) ||
        !Number.isInteger(quantum.toDepth) ||
        quantum.fromDepth < 0 ||
        quantum.toDepth < quantum.fromDepth ||
        !Number.isInteger(quantum.placementEvaluationDelta) ||
        quantum.placementEvaluationDelta < 0
    )
  ) {
    return false
  }
  const coldQuanta = trace.quanta.filter(
    ({ producerRole }) => producerRole === 'capacity-cold'
  )
  if (
    coldQuanta.length === 0 ||
    coldQuanta[0]?.phase !== 'initial' ||
    coldQuanta.some(
      ({ sourceRole, prefixDepth }) =>
        sourceRole !== undefined || prefixDepth !== undefined
    )
  ) {
    return false
  }
  const evaluationSum = trace.quanta.reduce(
    (sum, { placementEvaluationDelta }) => sum + placementEvaluationDelta,
    0
  )
  if (evaluationSum !== trace.aggregateConsumedPlacementEvaluations) {
    return false
  }
  const warmResumeIdentities = new Set(
    trace.quanta.flatMap((quantum) =>
      quantum.producerRole === 'capacity-warm-prefix' &&
      quantum.phase === 'resume' &&
      quantum.placementEvaluationDelta > 0
        ? [capacityLaneQuantumIdentity(quantum)]
        : []
    )
  )
  if (warmResumeIdentities.size > 1) return false
  for (const lane of warmLanes) {
    const laneIdentity = capacityLaneIdentity(lane.sourceRole, lane.prefixDepth)
    const laneQuanta = trace.quanta.filter(
      (quantum) =>
        quantum.producerRole === 'capacity-warm-prefix' &&
        capacityLaneQuantumIdentity(quantum) === laneIdentity
    )
    if (
      laneQuanta.length === 0 ||
      laneQuanta[0]?.phase !== 'initial' ||
      laneQuanta.some(
        (quantum, index) =>
          index > 0 &&
          quantum.fromDepth !== laneQuanta[index - 1]?.toDepth
      ) ||
      laneQuanta.reduce(
        (sum, { placementEvaluationDelta }) =>
          sum + placementEvaluationDelta,
        0
      ) !== lane.consumedPlacementEvaluations ||
      laneQuanta.at(-1)?.toDepth !== lane.completedDepths ||
      (lane.status === 'checkpointed-censored'
        ? laneQuanta.at(-1)?.outcome !== 'censored'
        : laneQuanta.at(-1)?.outcome !== 'settled')
    ) {
      return false
    }
  }
  return true
}

function capacityLaneIdentity(sourceRole: string, prefixDepth: number): string {
  return `${sourceRole}@${prefixDepth}`
}

function capacityLaneQuantumIdentity(
  quantum: IntrinsicCapacityLaneCoordinatorQuantum
): string {
  return capacityLaneIdentity(
    quantum.sourceRole ?? 'unknown',
    quantum.prefixDepth ?? 0
  )
}

export interface IntrinsicCapacityModeResult {
  readonly endpoint: IntrinsicCapacityEndpoint
  readonly trace: IntrinsicCapacityTrace
  readonly phaseTimings: IntrinsicCapacitySearchPhaseTimings | undefined
}

export interface RunIntrinsicCapacityModeInput {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly routing: IntrinsicCapacityRouting
  readonly preflight: IntrinsicCapacityPreflightOutcome
  /** Committed direct-constructor states; empty when complete mode was bypassed. */
  readonly prefixSources: ReadonlyArray<IntrinsicCapacityPrefixSource>
  /** Control arm for paired comparisons; production keeps prefix reuse on. */
  readonly disablePrefixReuse?: boolean
  readonly control?: IrregularNfpIfpControl
  readonly capturePhaseTimings?: boolean
  /** Runs protected warm-prefix lanes as observers without changing selection. */
  readonly captureWarmPrefixTelemetry?: boolean
  /** Runs one independent generic topology frontier without selecting it. */
  readonly captureCohesionShadow?: boolean
  /** Benchmark hook for the exact observer endpoint. */
  readonly onCohesionShadowLane?: (
    endpoint: IntrinsicCapacityEndpoint | undefined
  ) => void
  /** Benchmark artifact hook; never read by selection or production routing. */
  readonly onWarmPrefixLane?: (lane: {
    readonly sourceRole: string
    readonly prefixDepth: number
    readonly endpoint: IntrinsicCapacityEndpoint | undefined
  }) => void
  /** Existing protected cold work produced before complete-cohort settlement. */
  readonly scheduledColdStart?: IntrinsicCapacitySearchResult
  /** Allows settled warm lanes into the partial archive after a complete miss. */
  readonly admitWarmPrefixEndpoints?: boolean
  /** Coordinates cold and warm lanes under one aggregate evaluation budget. */
  readonly coordinateProtectedLanes?: boolean
  /** Coordinator-measured preflight runtime carried into the trace. */
  readonly preflightRuntimeMs?: number
  /** Coordinator-measured complete archive runtime carried into the trace. */
  readonly completeArchiveRuntimeMs?: number
  readonly retentionMode?: IntrinsicCapacityRetentionMode
}

export const INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS = 4 as const

/** Advances the protected cold lane once before complete-cohort settlement. */
export function runIntrinsicCapacitySchedulerColdQuantum(input: {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly checkpoint?: IntrinsicAnytimeCheckpoint
  readonly maximumDepthBoundaries?: number
  readonly control?: IrregularNfpIfpControl
  readonly capturePhaseTimings?: boolean
  readonly retentionMode?: IntrinsicCapacityRetentionMode
}): Effect.Effect<
  IntrinsicCapacitySearchResult,
  IntrinsicCapacityModeError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const materials = intrinsicCapacityMaterialAreas(input.preparedPieces)
    if (materials.kind === 'invalid') {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'schedulerMaterialAreas',
          message: `piece ${materials.pieceId} has no exact positive unpadded material area.`
        })
      )
    }
    return yield* runIntrinsicCapacityColdSearch({
      sheet: input.sheet,
      preparedPieces: input.preparedPieces,
      materialAreasByPieceId: materials.areasByPieceId,
      cavityCache: new Map(),
      maximumDepthBoundaries:
        input.maximumDepthBoundaries ??
        Math.min(
          INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS,
          Math.max(1, input.preparedPieces.length)
        ),
      ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
      schedulerDeficit: input.checkpoint?.schedulerDeficit ?? 1,
      ...(input.retentionMode === undefined
        ? {}
        : { retentionMode: input.retentionMode }),
      ...(input.control === undefined ? {} : { control: input.control }),
      ...(input.capturePhaseTimings === undefined
        ? {}
        : { capturePhaseTimings: input.capturePhaseTimings })
    })
  })
}

interface ProtectedCapacityLane {
  readonly role: 'capacity-cold' | 'capacity-warm-prefix'
  readonly sourceRole: string | undefined
  readonly prefixDepth: number | undefined
  readonly reusedPlacedCount: number
  readonly warmPrefixSeed: IntrinsicCapacityWarmPrefixSeed | undefined
  readonly elapsedMs: number
  readonly result: IntrinsicCapacitySearchResult
  readonly endpoints: ReadonlyArray<IntrinsicCapacityEndpoint>
  readonly selectedForContinuation: boolean
}

interface ProtectedCapacityLaneCoordinatorResult {
  readonly coldSearch: IntrinsicCapacitySearchResult
  readonly coldEndpoints: ReadonlyArray<IntrinsicCapacityEndpoint>
  readonly warmEndpoints: ReadonlyArray<IntrinsicCapacityEndpoint>
  readonly warmPrefixLanes: ReadonlyArray<IntrinsicCapacityWarmPrefixLaneTrace>
  readonly trace: IntrinsicCapacityLaneCoordinatorTrace
  readonly elapsedMs: number
}

const INTRINSIC_CAPACITY_WARM_PILOT_DEPTH_BOUNDARIES = 1 as const

/**
 * Gives every protected lane one bounded sample, then resumes only the best
 * paused lane while a shared aggregate budget can reserve one full depth.
 */
function runProtectedCapacityLaneCoordinator(input: {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly materialAreasByPieceId: ReadonlyMap<PieceId, bigint>
  readonly fittingDescriptors: ReadonlyArray<IntrinsicCapacityPrefixDescriptor>
  readonly scheduledColdStart: IntrinsicCapacitySearchResult | undefined
  readonly control: IrregularNfpIfpControl | undefined
  readonly capturePhaseTimings: boolean | undefined
  readonly retentionMode: IntrinsicCapacityRetentionMode | undefined
  readonly onWarmPrefixLane:
    | ((lane: {
        readonly sourceRole: string
        readonly prefixDepth: number
        readonly endpoint: IntrinsicCapacityEndpoint | undefined
      }) => void)
    | undefined
}): Effect.Effect<
  ProtectedCapacityLaneCoordinatorResult,
  IntrinsicCapacityModeError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const basePlacementEvaluationCap = Math.max(
      INTRINSIC_CAPACITY_V1_BOUNDS.minimumPlacementEvaluationCap,
      input.preparedPieces.length *
        INTRINSIC_CAPACITY_V1_BOUNDS.placementEvaluationQuotaPerDepth
    )
    const aggregatePlacementEvaluationCap = basePlacementEvaluationCap * 2
    const lanes: ProtectedCapacityLane[] = []
    const coordinatorQuanta: IntrinsicCapacityLaneCoordinatorQuantum[] = []
    const appendCoordinatorQuantum = (
      quantum: Omit<IntrinsicCapacityLaneCoordinatorQuantum, 'ordinal'>
    ): void => {
      coordinatorQuanta.push({
        ordinal: coordinatorQuanta.length,
        ...quantum
      })
    }

    const coldStartedAt = performance.now()
    const coldResult =
      input.scheduledColdStart ??
      (yield* runIntrinsicCapacityColdSearch({
        sheet: input.sheet,
        preparedPieces: input.preparedPieces,
        materialAreasByPieceId: input.materialAreasByPieceId,
        cavityCache: new Map(),
        maximumDepthBoundaries: Math.min(
          INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS,
          Math.max(1, input.preparedPieces.length)
        ),
        schedulerDeficit: 1,
        ...(input.retentionMode === undefined
          ? {}
          : { retentionMode: input.retentionMode }),
        ...(input.control === undefined ? {} : { control: input.control }),
        ...(input.capturePhaseTimings === undefined
          ? {}
          : { capturePhaseTimings: input.capturePhaseTimings })
      }))
    lanes.push(
      makeProtectedCapacityLane({
        role: 'capacity-cold',
        result: coldResult,
        elapsedMs: Math.max(0, performance.now() - coldStartedAt),
        sheet: input.sheet,
        preparedPieces: input.preparedPieces,
        materialAreasByPieceId: input.materialAreasByPieceId
      })
    )
    appendCoordinatorQuantum({
      producerRole: 'capacity-cold',
      sourceRole: undefined,
      prefixDepth: undefined,
      phase: 'initial',
      fromDepth: 0,
      toDepth: coldResult.trace.completedDepths,
      placementEvaluationDelta: coldResult.trace.consumedPlacementEvaluations,
      outcome: coldResult.status === 'paused' ? 'checkpointed' : 'settled'
    })
    const continuedLaneIndexes = new Set<number>()
    const initialColdLane = lanes[0]
    if (initialColdLane?.result.status === 'paused') {
      const checkpoint = initialColdLane.result.checkpoint
      if (checkpoint === undefined) {
        return yield* Effect.fail(
          new IntrinsicCapacityError({
            operation: 'capacityLaneCoordinator',
            message: 'paused protected cold lane has no checkpoint.'
          })
        )
      }
      const resumedAt = performance.now()
      const resumed = yield* runIntrinsicCapacityColdSearch({
        sheet: input.sheet,
        preparedPieces: input.preparedPieces,
        materialAreasByPieceId: input.materialAreasByPieceId,
        cavityCache: new Map(),
        checkpoint,
        schedulerDeficit: checkpoint.schedulerDeficit,
        ...(input.retentionMode === undefined
          ? {}
          : { retentionMode: input.retentionMode }),
        ...(input.control === undefined ? {} : { control: input.control }),
        ...(input.capturePhaseTimings === undefined
          ? {}
          : { capturePhaseTimings: input.capturePhaseTimings })
      })
      lanes[0] = makeProtectedCapacityLane({
        role: 'capacity-cold',
        result: resumed,
        elapsedMs:
          initialColdLane.elapsedMs + Math.max(0, performance.now() - resumedAt),
        selectedForContinuation: true,
        sheet: input.sheet,
        preparedPieces: input.preparedPieces,
        materialAreasByPieceId: input.materialAreasByPieceId
      })
      continuedLaneIndexes.add(0)
      appendCoordinatorQuantum({
        producerRole: 'capacity-cold',
        sourceRole: undefined,
        prefixDepth: undefined,
        phase: 'resume',
        fromDepth: initialColdLane.result.trace.completedDepths,
        toDepth: resumed.trace.completedDepths,
        placementEvaluationDelta: Math.max(
          0,
          resumed.trace.consumedPlacementEvaluations -
            initialColdLane.result.trace.consumedPlacementEvaluations
        ),
        outcome: resumed.status === 'paused' ? 'censored' : 'settled'
      })
    }

    for (const descriptor of input.fittingDescriptors) {
      const laneStartedAt = performance.now()
      const warmPrefixSeed: IntrinsicCapacityWarmPrefixSeed = {
        sourceRole: descriptor.role,
        depth: descriptor.depth,
        state: descriptor.state
      }
      const result = yield* runIntrinsicCapacityColdSearch({
        sheet: input.sheet,
        preparedPieces: input.preparedPieces,
        materialAreasByPieceId: input.materialAreasByPieceId,
        cavityCache: new Map(),
        warmPrefixSeed,
        maximumDepthBoundaries: INTRINSIC_CAPACITY_WARM_PILOT_DEPTH_BOUNDARIES,
        ...(input.retentionMode === undefined
          ? {}
          : { retentionMode: input.retentionMode }),
        ...(input.control === undefined ? {} : { control: input.control }),
        ...(input.capturePhaseTimings === undefined
          ? {}
          : { capturePhaseTimings: input.capturePhaseTimings })
      })
      lanes.push(
        makeProtectedCapacityLane({
          role: 'capacity-warm-prefix',
          sourceRole: descriptor.role,
          prefixDepth: descriptor.depth,
          reusedPlacedCount: descriptor.placedPreparedIds.length,
          warmPrefixSeed,
          result,
          elapsedMs: Math.max(0, performance.now() - laneStartedAt),
          sheet: input.sheet,
          preparedPieces: input.preparedPieces,
          materialAreasByPieceId: input.materialAreasByPieceId
        })
      )
      appendCoordinatorQuantum({
        producerRole: 'capacity-warm-prefix',
        sourceRole: descriptor.role,
        prefixDepth: descriptor.depth,
        phase: 'initial',
        fromDepth: descriptor.depth,
        toDepth: result.trace.completedDepths,
        placementEvaluationDelta: result.trace.consumedPlacementEvaluations,
        outcome: result.status === 'paused' ? 'checkpointed' : 'settled'
      })
    }

    let warmConsumedPlacementEvaluations = lanes.reduce(
      (sum, lane) =>
        lane.role === 'capacity-warm-prefix'
          ? sum + lane.result.trace.consumedPlacementEvaluations
          : sum,
      0
    )
    const selectedWarmLaneIndex = selectProtectedWarmSettlementLane(lanes)
    while (
      selectedWarmLaneIndex !== undefined &&
      basePlacementEvaluationCap - warmConsumedPlacementEvaluations >=
      INTRINSIC_CAPACITY_V1_BOUNDS.placementEvaluationQuotaPerDepth
    ) {
      const selectedWarmLane = lanes[selectedWarmLaneIndex]
      const checkpoint = selectedWarmLane?.result.checkpoint
      if (
        selectedWarmLane === undefined ||
        selectedWarmLane.warmPrefixSeed === undefined ||
        checkpoint === undefined
      ) {
        break
      }
      const resumedAt = performance.now()
      const resumed = yield* runIntrinsicCapacityColdSearch({
        sheet: input.sheet,
        preparedPieces: input.preparedPieces,
        materialAreasByPieceId: input.materialAreasByPieceId,
        cavityCache: new Map(),
        warmPrefixSeed: selectedWarmLane.warmPrefixSeed,
        checkpoint,
        schedulerDeficit: checkpoint.schedulerDeficit,
        maximumDepthBoundaries: 1,
        ...(input.retentionMode === undefined
          ? {}
          : { retentionMode: input.retentionMode }),
        ...(input.control === undefined ? {} : { control: input.control }),
        ...(input.capturePhaseTimings === undefined
          ? {}
          : { capturePhaseTimings: input.capturePhaseTimings })
      })
      const consumedDelta =
        resumed.trace.consumedPlacementEvaluations -
        selectedWarmLane.result.trace.consumedPlacementEvaluations
      warmConsumedPlacementEvaluations += Math.max(0, consumedDelta)
      lanes[selectedWarmLaneIndex] = makeProtectedCapacityLane({
        role: 'capacity-warm-prefix',
        sourceRole: selectedWarmLane.sourceRole ?? 'unknown',
        prefixDepth: selectedWarmLane.prefixDepth ?? 0,
        reusedPlacedCount: selectedWarmLane.reusedPlacedCount,
        warmPrefixSeed: selectedWarmLane.warmPrefixSeed,
        result: resumed,
        elapsedMs:
          selectedWarmLane.elapsedMs + Math.max(0, performance.now() - resumedAt),
        selectedForContinuation: true,
        sheet: input.sheet,
        preparedPieces: input.preparedPieces,
        materialAreasByPieceId: input.materialAreasByPieceId
      })
      continuedLaneIndexes.add(selectedWarmLaneIndex)
      appendCoordinatorQuantum({
        producerRole: 'capacity-warm-prefix',
        sourceRole: selectedWarmLane.sourceRole ?? 'unknown',
        prefixDepth: selectedWarmLane.prefixDepth ?? 0,
        phase: 'resume',
        fromDepth: selectedWarmLane.result.trace.completedDepths,
        toDepth: resumed.trace.completedDepths,
        placementEvaluationDelta: Math.max(0, consumedDelta),
        outcome: resumed.status === 'paused' ? 'checkpointed' : 'settled'
      })
    }

    const coldLane = lanes.find(({ role }) => role === 'capacity-cold')
    if (coldLane === undefined) {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'capacityLaneCoordinator',
          message: 'protected capacity coordination lost the cold lane.'
        })
      )
    }
    const warmLanes = lanes.filter(
      (
        lane
      ): lane is ProtectedCapacityLane & {
        readonly role: 'capacity-warm-prefix'
      } => lane.role === 'capacity-warm-prefix'
    )
    for (const lane of warmLanes) {
      input.onWarmPrefixLane?.({
        sourceRole: lane.sourceRole ?? 'unknown',
        prefixDepth: lane.prefixDepth ?? 0,
        endpoint: lane.endpoints[0]
      })
    }
    const retainedCheckpointCount = lanes.filter(
      ({ result }) => result.status === 'paused'
    ).length
    for (const lane of warmLanes) {
      if (lane.result.status === 'paused') {
        appendCoordinatorQuantum({
          producerRole: 'capacity-warm-prefix',
          sourceRole: lane.sourceRole ?? 'unknown',
          prefixDepth: lane.prefixDepth ?? 0,
          phase: 'censor',
          fromDepth: lane.result.trace.completedDepths,
          toDepth: lane.result.trace.completedDepths,
          placementEvaluationDelta: 0,
          outcome: 'censored'
        })
      }
    }
    const aggregateConsumedPlacementEvaluations =
      coldLane.result.trace.consumedPlacementEvaluations +
      warmConsumedPlacementEvaluations
    return {
      coldSearch: coldLane.result,
      coldEndpoints: coldLane.endpoints,
      warmEndpoints: warmLanes.flatMap(({ endpoints }) => endpoints),
      warmPrefixLanes: warmLanes.map((lane) => ({
        sourceRole: lane.sourceRole ?? 'unknown',
        prefixDepth: lane.prefixDepth ?? 0,
        reusedPlacedCount: lane.reusedPlacedCount,
        status:
          lane.result.status === 'paused' ? 'checkpointed-censored' : 'settled',
        selectedForContinuation: lane.selectedForContinuation,
        checkpointRetained: lane.result.checkpoint !== undefined,
        consumedPlacementEvaluations: lane.result.trace.consumedPlacementEvaluations,
        completedDepths: lane.result.trace.completedDepths,
        elapsedMs: lane.elapsedMs,
        endpoint:
          lane.endpoints[0] === undefined
            ? undefined
            : intrinsicCapacityObjective(lane.endpoints[0])
      })),
      trace: {
        version: 'intrinsic-capacity-lane-coordinator-v2',
        aggregatePlacementEvaluationCap,
        aggregateConsumedPlacementEvaluations,
        warmPilotDepthBoundaries: INTRINSIC_CAPACITY_WARM_PILOT_DEPTH_BOUNDARIES,
        continuedProducers: [...continuedLaneIndexes].reduce<
          IntrinsicCapacityContinuedProducer[]
        >((continued, laneIndex) => {
          const lane = lanes[laneIndex]
          if (lane === undefined) return continued
          continued.push(
            lane.role === 'capacity-cold'
              ? { role: 'capacity-cold' }
              : {
                  role: 'capacity-warm-prefix',
                  sourceRole: lane.sourceRole ?? 'unknown',
                  prefixDepth: lane.prefixDepth ?? 0
                }
          )
          return continued
        }, []),
        retainedCheckpointCount,
        censoredLaneCount: retainedCheckpointCount,
        quanta: coordinatorQuanta
      },
      elapsedMs: Math.max(0, performance.now() - startedAt)
    }
  })
}

function makeProtectedCapacityLane(input: {
  readonly role: 'capacity-cold' | 'capacity-warm-prefix'
  readonly sourceRole?: string
  readonly prefixDepth?: number
  readonly reusedPlacedCount?: number
  readonly warmPrefixSeed?: IntrinsicCapacityWarmPrefixSeed
  readonly result: IntrinsicCapacitySearchResult
  readonly elapsedMs: number
  readonly selectedForContinuation?: boolean
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly materialAreasByPieceId: ReadonlyMap<PieceId, bigint>
}): ProtectedCapacityLane {
  const checkpoint = input.result.checkpoint
  const endpoints =
    input.result.status === 'settled'
      ? input.result.endpoints
      : checkpoint === undefined
        ? []
        : materializeIntrinsicCapacityCheckpointEndpoints({
            sheet: input.sheet,
            preparedPieces: input.preparedPieces,
            materialAreasByPieceId: input.materialAreasByPieceId,
            cavityCache: new Map(),
            checkpoint,
            ...(input.warmPrefixSeed === undefined
              ? {}
              : { warmPrefixSeed: input.warmPrefixSeed })
          })
  return {
    role: input.role,
    sourceRole: input.sourceRole,
    prefixDepth: input.prefixDepth,
    reusedPlacedCount: input.reusedPlacedCount ?? 0,
    warmPrefixSeed: input.warmPrefixSeed,
    elapsedMs: input.elapsedMs,
    result: input.result,
    endpoints,
    selectedForContinuation: input.selectedForContinuation === true
  }
}

function selectProtectedWarmSettlementLane(
  lanes: ReadonlyArray<ProtectedCapacityLane>
): number | undefined {
  const candidates = lanes.flatMap((lane, index) =>
    lane.role === 'capacity-warm-prefix' &&
    lane.result.status === 'paused' &&
    lane.result.checkpoint !== undefined &&
    lane.endpoints[0] !== undefined
      ? [{ lane, index }]
      : []
  )
  const maximumPrefixDepth = Math.max(
    ...candidates.map(({ lane }) => lane.prefixDepth ?? 0)
  )
  const deepestCandidates = candidates.filter(
    ({ lane }) => (lane.prefixDepth ?? 0) === maximumPrefixDepth
  )
  const sourcePriority = [
    'canonical-grid',
    'open-pocket-first',
    'legacy-absolute-envelope'
  ]
  for (const sourceRole of sourcePriority) {
    const candidate = deepestCandidates.find(
      ({ lane }) => lane.sourceRole === sourceRole
    )
    if (candidate !== undefined) return candidate.index
  }
  return deepestCandidates[0]?.index
}

function runIntrinsicCapacityCohesionShadow(input: {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly materialAreasByPieceId: ReadonlyMap<PieceId, bigint>
  readonly control?: IrregularNfpIfpControl
  readonly capturePhaseTimings?: boolean
}): Effect.Effect<
  {
    readonly endpoint: IntrinsicCapacityEndpoint | undefined
    readonly trace: IntrinsicCapacityCohesionShadowTrace
  },
  IntrinsicCapacityModeError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const result = yield* runIntrinsicCapacityColdSearch({
      sheet: input.sheet,
      preparedPieces: input.preparedPieces,
      materialAreasByPieceId: input.materialAreasByPieceId,
      cavityCache: new Map(),
      retentionMode: 'cohesion-frontier-shadow',
      ...(input.control === undefined ? {} : { control: input.control }),
      ...(input.capturePhaseTimings === undefined
        ? {}
        : { capturePhaseTimings: input.capturePhaseTimings })
    })
    if (result.status !== 'settled') {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'capacityCohesionShadow',
          message: 'the independent cohesion observer did not settle.'
        })
      )
    }
    const endpoint = result.endpoints[0]
    return {
      endpoint,
      trace: {
        producerRole: 'capacity-cohesion-shadow',
        status: 'settled',
        outputInfluence: 'none',
        consumedPlacementEvaluations:
          result.trace.consumedPlacementEvaluations,
        completedDepths: result.trace.completedDepths,
        elapsedMs: Math.max(0, performance.now() - startedAt),
        endpoint:
          endpoint === undefined ? undefined : intrinsicCapacityObjective(endpoint),
        retentionDepths: result.trace.topologyRetentionDepths
      }
    }
  })
}

type IntrinsicCapacityModeError =
  | IntrinsicCapacityError
  | IrregularGeometryInputError
  | IrregularNestingNotImplementedError
  | IrregularNfpIfpControlAbortError

/**
 * Runs intrinsic-capacity-v1: terminalize fitting complete-search prefixes
 * into zero-evaluation incumbents, run the empty-start cold subset search,
 * and settle one exact best-known partial endpoint with a complete
 * placed/unplaced partition of the request.
 */
export function runIntrinsicCapacityMode(
  input: RunIntrinsicCapacityModeInput
): Effect.Effect<
  IntrinsicCapacityModeResult,
  IntrinsicCapacityModeError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const materials = intrinsicCapacityMaterialAreas(input.preparedPieces)
    if (materials.kind === 'invalid') {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'capacityMaterialAreas',
          message: `piece ${materials.pieceId} has no exact positive unpadded material area.`
        })
      )
    }
    const preparedIds = input.preparedPieces.map(intrinsicCapacityPreparedPieceId)
    const cavityCache: IntrinsicCapacityCavityCache = new Map()

    const prefixStartedAt = performance.now()
    const descriptors =
      input.disablePrefixReuse === true
        ? []
        : captureIntrinsicCapacityPrefixDescriptors({
            preparedPieces: input.preparedPieces,
            sources: input.prefixSources
          })
    const terminalization = terminalizeIntrinsicCapacityPrefixEndpoints({
      sheet: input.sheet,
      descriptors,
      materialAreasByPieceId: materials.areasByPieceId,
      cavityCache
    })
    const prefixTerminalizationMs = Math.max(0, performance.now() - prefixStartedAt)

    const coldSearchStartedAt = performance.now()
    const scheduledColdStart = input.scheduledColdStart
    const coordinated =
      input.coordinateProtectedLanes === true
        ? yield* runProtectedCapacityLaneCoordinator({
            sheet: input.sheet,
            preparedPieces: input.preparedPieces,
            materialAreasByPieceId: materials.areasByPieceId,
            fittingDescriptors: terminalization.fittingDescriptors,
            scheduledColdStart,
            control: input.control,
            capturePhaseTimings: input.capturePhaseTimings,
            retentionMode: input.retentionMode,
            onWarmPrefixLane: input.onWarmPrefixLane
          })
        : undefined
    const coldSearch =
      coordinated?.coldSearch ??
      (scheduledColdStart?.status === 'settled'
        ? scheduledColdStart
        : yield* runIntrinsicCapacityColdSearch({
            sheet: input.sheet,
            preparedPieces: input.preparedPieces,
            materialAreasByPieceId: materials.areasByPieceId,
            cavityCache,
            ...(input.retentionMode === undefined
              ? {}
              : { retentionMode: input.retentionMode }),
            ...(scheduledColdStart?.checkpoint === undefined
              ? terminalization.incumbent === undefined
                ? {}
                : { incumbent: terminalization.incumbent }
              : {
                  checkpoint: scheduledColdStart.checkpoint,
                  schedulerDeficit: scheduledColdStart.checkpoint.schedulerDeficit
                }),
            ...(input.control === undefined ? {} : { control: input.control }),
            ...(input.capturePhaseTimings === undefined
              ? {}
              : { capturePhaseTimings: input.capturePhaseTimings })
          }))
    const coldSearchMs =
      coordinated?.elapsedMs ?? Math.max(0, performance.now() - coldSearchStartedAt)

    const cohesionShadow =
      input.captureCohesionShadow === true
        ? yield* runIntrinsicCapacityCohesionShadow({
            sheet: input.sheet,
            preparedPieces: input.preparedPieces,
            materialAreasByPieceId: materials.areasByPieceId,
            ...(input.control === undefined ? {} : { control: input.control }),
            ...(input.capturePhaseTimings === undefined
              ? {}
              : { capturePhaseTimings: input.capturePhaseTimings })
          })
        : undefined
    input.onCohesionShadowLane?.(cohesionShadow?.endpoint)

    let warmPrefixLanes:
      | ReadonlyArray<IntrinsicCapacityWarmPrefixLaneTrace>
      | undefined = coordinated?.warmPrefixLanes
    const warmEndpoints: IntrinsicCapacityEndpoint[] = [
      ...(coordinated?.warmEndpoints ?? [])
    ]
    if (coordinated === undefined && input.captureWarmPrefixTelemetry === true) {
      const measuredLanes: IntrinsicCapacityWarmPrefixLaneTrace[] = []
      for (const descriptor of terminalization.fittingDescriptors) {
        const laneStartedAt = performance.now()
        const lane = yield* runIntrinsicCapacityColdSearch({
          sheet: input.sheet,
          preparedPieces: input.preparedPieces,
          materialAreasByPieceId: materials.areasByPieceId,
          cavityCache: new Map(),
          warmPrefixSeed: {
            sourceRole: descriptor.role,
            depth: descriptor.depth,
            state: descriptor.state
          },
          ...(input.retentionMode === undefined
            ? {}
            : { retentionMode: input.retentionMode }),
          ...(input.control === undefined ? {} : { control: input.control }),
          ...(input.capturePhaseTimings === undefined
            ? {}
            : { capturePhaseTimings: input.capturePhaseTimings })
        })
        if (lane.status !== 'settled') {
          return yield* Effect.fail(
            new IntrinsicCapacityError({
              operation: 'warmPrefixLane',
              message: `warm prefix ${descriptor.role}@${descriptor.depth} did not settle.`
            })
          )
        }
        const endpoint = lane.endpoints[0]
        warmEndpoints.push(...lane.endpoints)
        input.onWarmPrefixLane?.({
          sourceRole: descriptor.role,
          prefixDepth: descriptor.depth,
          endpoint
        })
        measuredLanes.push({
          sourceRole: descriptor.role,
          prefixDepth: descriptor.depth,
          reusedPlacedCount: descriptor.placedPreparedIds.length,
          status: 'settled',
          selectedForContinuation: false,
          checkpointRetained: false,
          consumedPlacementEvaluations: lane.trace.consumedPlacementEvaluations,
          completedDepths: lane.trace.completedDepths,
          elapsedMs: Math.max(0, performance.now() - laneStartedAt),
          endpoint:
            endpoint === undefined ? undefined : intrinsicCapacityObjective(endpoint)
        })
      }
      warmPrefixLanes = measuredLanes
    }

    const candidates = retainIntrinsicAnytimeArchiveNamespace({
      namespace: 'partial',
      endpoints: [
        ...(coordinated?.coldEndpoints ?? coldSearch.endpoints),
        ...terminalization.endpoints,
        ...(input.admitWarmPrefixEndpoints === true ? warmEndpoints : [])
      ],
      identity: ({ canonicalGeometryHash }) => canonicalGeometryHash,
      validate: (endpoint) =>
        endpoint.metrics.placedCount === endpoint.placedPreparedIds.length &&
        intrinsicCapacityEndpointPartitionsRequest(endpoint, preparedIds),
      selectDuplicate: (retained, candidate) =>
        compareIntrinsicCapacityEndpoints(candidate, retained) < 0 ? candidate : retained,
      rank: (unique) => unique.toSorted(compareIntrinsicCapacityEndpoints)
    })
    const selected = candidates[0] ?? makeAllUnplacedFallbackEndpoint(input, materials.areasByPieceId, cavityCache)
    if (selected === undefined) {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'capacitySettlement',
          message: 'capacity mode could not settle any exact partial endpoint.'
        })
      )
    }
    if (!intrinsicCapacityEndpointPartitionsRequest(selected, preparedIds)) {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'capacityPartition',
          message: 'settled capacity endpoint does not exactly partition the prepared request.'
        })
      )
    }

    const incumbent = terminalization.incumbent
    return {
      endpoint: selected,
      trace: {
        routing: input.routing,
        preflight: input.preflight,
        prefixes: {
          capturedCount: terminalization.capturedCount,
          fittingCount: terminalization.fittingCount,
          rejectedCount: terminalization.rejectedCount,
          terminalizedCount: terminalization.endpoints.length,
          descriptors: descriptors.map(({ role, depth }) => ({ role, depth }))
        },
        prefixIncumbent:
          incumbent === undefined
            ? undefined
            : {
                sourceRole: incumbent.sourceRole,
                prefixDepth: incumbent.prefixDepth,
                placedCount: incumbent.metrics.placedCount,
                placedMaterialAreaMm2: incumbent.metrics.placedMaterialAreaMm2,
                selectedRotationDeg: incumbent.selectedRotationDeg,
                canonicalGeometryHash: incumbent.canonicalGeometryHash
        },
        coldSearch: coldSearch.trace,
        warmPrefixLanes,
        warmPrefixEndpointsAdmitted: input.admitWarmPrefixEndpoints === true,
        cohesionShadow: cohesionShadow?.trace,
        laneCoordinator: coordinated?.trace,
        selected: {
          ...intrinsicCapacityObjective(selected),
          unplacedCount: selected.unplacedPreparedIds.length,
          placedMaterialAreaMm2: selected.metrics.placedMaterialAreaMm2,
          selectedRotationDeg: selected.selectedRotationDeg
        },
        preflightRuntimeMs: input.preflightRuntimeMs,
        completeArchiveRuntimeMs: input.completeArchiveRuntimeMs,
        prefixTerminalizationMs,
        coldSearchMs,
        runtimeMs: Math.max(0, performance.now() - startedAt)
      },
      phaseTimings: coldSearch.phaseTimings
    }
  })
}

/**
 * Honest terminal fallback when neither the cold beam nor a prefix produced a
 * legal endpoint: every prepared piece is reported unplaced.
 */
function makeAllUnplacedFallbackEndpoint(
  input: RunIntrinsicCapacityModeInput,
  materialAreasByPieceId: ReadonlyMap<PieceId, bigint>,
  cavityCache: IntrinsicCapacityCavityCache
): IntrinsicCapacityEndpoint | undefined {
  return materializeIntrinsicCapacityEndpoint({
    sheet: input.sheet,
    state: IrregularBeamState.empty(input.preparedPieces),
    unplacedPreparedIds: input.preparedPieces.map(intrinsicCapacityPreparedPieceId),
    origin: 'cold-search',
    materialAreasByPieceId,
    cavityCache
  })
}
