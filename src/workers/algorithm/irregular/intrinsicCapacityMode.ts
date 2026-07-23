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
  type IntrinsicCapacityPrefixSource
} from './intrinsicCapacityPrefixes.js'
import {
  runIntrinsicCapacityColdSearch,
  type IntrinsicCapacitySearchResult,
  type IntrinsicCapacitySearchPhaseTimings,
  type IntrinsicCapacitySearchTrace
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
  readonly status: 'settled'
  readonly consumedPlacementEvaluations: number
  readonly completedDepths: number
  readonly elapsedMs: number
  readonly endpoint: IntrinsicCapacityObjective | undefined
}

export interface IntrinsicCapacityTrace {
  readonly routing: IntrinsicCapacityRouting
  readonly preflight: IntrinsicCapacityPreflightOutcome
  readonly prefixes: IntrinsicCapacityPrefixTrace
  readonly prefixIncumbent: IntrinsicCapacityIncumbentTrace | undefined
  readonly coldSearch: IntrinsicCapacitySearchTrace
  /** Observer-only independent warm lanes; excluded from final selection. */
  readonly warmPrefixLanes: ReadonlyArray<IntrinsicCapacityWarmPrefixLaneTrace> | undefined
  readonly warmPrefixEndpointsAdmitted: boolean
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
  /** Coordinator-measured preflight runtime carried into the trace. */
  readonly preflightRuntimeMs?: number
  /** Coordinator-measured complete archive runtime carried into the trace. */
  readonly completeArchiveRuntimeMs?: number
}

export const INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS = 4 as const

/** Advances the protected cold lane once before complete-cohort settlement. */
export function runIntrinsicCapacitySchedulerColdQuantum(input: {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly control?: IrregularNfpIfpControl
  readonly capturePhaseTimings?: boolean
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
      maximumDepthBoundaries: Math.min(
        INTRINSIC_ANYTIME_SCHEDULER_COLD_QUANTUM_DEPTHS,
        Math.max(1, input.preparedPieces.length)
      ),
      schedulerDeficit: 1,
      ...(input.control === undefined ? {} : { control: input.control }),
      ...(input.capturePhaseTimings === undefined
        ? {}
        : { capturePhaseTimings: input.capturePhaseTimings })
    })
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
    const coldSearch =
      scheduledColdStart?.status === 'settled'
        ? scheduledColdStart
        : yield* runIntrinsicCapacityColdSearch({
            sheet: input.sheet,
            preparedPieces: input.preparedPieces,
            materialAreasByPieceId: materials.areasByPieceId,
            cavityCache,
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
          })
    const coldSearchMs = Math.max(0, performance.now() - coldSearchStartedAt)

    let warmPrefixLanes: ReadonlyArray<IntrinsicCapacityWarmPrefixLaneTrace> | undefined
    const warmEndpoints: IntrinsicCapacityEndpoint[] = []
    if (input.captureWarmPrefixTelemetry === true) {
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
        ...coldSearch.endpoints,
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
