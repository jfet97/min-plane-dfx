import { Effect } from 'effect'
import { performance } from 'node:perf_hooks'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type { IrregularPreparedPiece } from '@shared/irregular/domain.js'
import type { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import type { NfpIfpService } from '../../irregular/services.js'
import { intrinsicCapacityMaterialAreas } from './intrinsicCapacityMaterial.js'
import type { IntrinsicCapacityPreflightOutcome } from './intrinsicCapacityPreflight.js'
import {
  INTRINSIC_ANYTIME_CHECKPOINT_VERSION,
  runIntrinsicCapacityColdSearch
} from './intrinsicCapacitySearch.js'

export const INTRINSIC_CAPACITY_NO_SKIP_PROBE_DEPTH = 4 as const

export interface IntrinsicCapacityPressureTelemetry {
  readonly minimumCollisionAreaPressurePpm: bigint
  readonly maximumSingletonSpanPressurePpm: bigint
}

export interface IntrinsicCapacityNoSkipProbeTelemetry {
  readonly maximumDepth: number
  readonly completedDepths: number
  readonly noSkipFrontierPresent: boolean | undefined
  readonly firstLossDepth: number | undefined
  readonly consumedPlacementEvaluations: number
  readonly elapsedMs: number
  readonly status: 'observed' | 'trivial' | 'unavailable'
  readonly unavailableReason: string | undefined
  readonly checkpointVersion: typeof INTRINSIC_ANYTIME_CHECKPOINT_VERSION
}

/** Observer-only telemetry. No field is consumed by routing or ranking. */
export interface IntrinsicCapacityShadowTelemetry {
  readonly pressure: IntrinsicCapacityPressureTelemetry
  readonly noSkipProbe: IntrinsicCapacityNoSkipProbeTelemetry
  readonly routingInfluence: 'none'
}

export function measureIntrinsicCapacityShadowTelemetry(input: {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly preflight: IntrinsicCapacityPreflightOutcome
}): Effect.Effect<
  IntrinsicCapacityShadowTelemetry,
  never,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const pressure: IntrinsicCapacityPressureTelemetry = {
      minimumCollisionAreaPressurePpm:
        input.preflight.measurements.minimumCollisionAreaPressurePpm,
      maximumSingletonSpanPressurePpm:
        input.preflight.measurements.maximumSingletonSpanPressurePpm
    }
    if (input.preparedPieces.length <= 1) {
      return {
        pressure,
        noSkipProbe: {
          maximumDepth: input.preparedPieces.length,
          completedDepths: input.preparedPieces.length,
          noSkipFrontierPresent:
            input.preflight.measurements.singletonInfeasiblePieceIds.length === 0,
          firstLossDepth:
            input.preflight.measurements.singletonInfeasiblePieceIds.length === 0 ? undefined : 1,
          consumedPlacementEvaluations: 0,
          elapsedMs: 0,
          status: 'trivial',
          unavailableReason: undefined,
          checkpointVersion: INTRINSIC_ANYTIME_CHECKPOINT_VERSION
        },
        routingInfluence: 'none'
      }
    }

    const materials = intrinsicCapacityMaterialAreas(input.preparedPieces)
    if (materials.kind === 'invalid') {
      return unavailableTelemetry(
        pressure,
        Math.min(INTRINSIC_CAPACITY_NO_SKIP_PROBE_DEPTH, input.preparedPieces.length - 1),
        `piece ${materials.pieceId} has no exact material accounting`
      )
    }
    const maximumDepth = Math.min(
      INTRINSIC_CAPACITY_NO_SKIP_PROBE_DEPTH,
      input.preparedPieces.length - 1
    )
    const startedAt = performance.now()
    return yield* runIntrinsicCapacityColdSearch({
      sheet: input.sheet,
      preparedPieces: input.preparedPieces,
      materialAreasByPieceId: materials.areasByPieceId,
      cavityCache: new Map(),
      maximumDepthBoundaries: maximumDepth
    }).pipe(
      Effect.map((probe) => {
        const checkpoint = probe.checkpoint
        if (probe.status !== 'paused' || checkpoint === undefined) {
          return unavailableTelemetry(
            pressure,
            maximumDepth,
            'bounded no-skip probe did not pause at its requested depth boundary',
            Math.max(0, performance.now() - startedAt)
          )
        }
        return {
          pressure,
          noSkipProbe: {
            maximumDepth,
            completedDepths: checkpoint.nextDepth,
            noSkipFrontierPresent: checkpoint.noSkipFrontier.present,
            firstLossDepth: checkpoint.noSkipFrontier.firstLossDepth,
            consumedPlacementEvaluations:
              checkpoint.budgetLedgers.totalConsumedPlacementEvaluations,
            elapsedMs: Math.max(0, performance.now() - startedAt),
            status: 'observed' as const,
            unavailableReason: undefined,
            checkpointVersion: checkpoint.version
          },
          routingInfluence: 'none' as const
        }
      }),
      Effect.catch((error) =>
        Effect.succeed(
          unavailableTelemetry(
            pressure,
            maximumDepth,
            error.message,
            Math.max(0, performance.now() - startedAt)
          )
        )
      )
    )
  })
}

function unavailableTelemetry(
  pressure: IntrinsicCapacityPressureTelemetry,
  maximumDepth: number,
  unavailableReason: string,
  elapsedMs = 0
): IntrinsicCapacityShadowTelemetry {
  return {
    pressure,
    noSkipProbe: {
      maximumDepth,
      completedDepths: 0,
      noSkipFrontierPresent: undefined,
      firstLossDepth: undefined,
      consumedPlacementEvaluations: 0,
      elapsedMs,
      status: 'unavailable',
      unavailableReason,
      checkpointVersion: INTRINSIC_ANYTIME_CHECKPOINT_VERSION
    },
    routingInfluence: 'none'
  }
}
