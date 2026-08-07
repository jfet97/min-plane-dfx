import type { IrregularBackend } from '@shared/irregular/backendSelection.js'
import type { NestingRequest } from '@shared/domain/nesting.js'
import type { IrregularNestingSettings } from '@shared/irregular/domain.js'
import { WorkerResponseFailureError } from '@shared/protocol/worker.js'
import { Effect, Layer } from 'effect'
import {
  computeIrregularNesting,
  type ComputeIrregularNestingOptions,
  type IrregularComputeResult,
  type IrregularStateSnapshot
} from '../algorithm/irregular/computeIrregularNesting.js'
import { IrregularLayoutScorer } from '../algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../algorithm/irregular/irregularPlacementScorer.js'
import { CollisionGeometryBuilder } from './collisionGeometryBuilder.js'
import {
  executeIrregularBackend,
  type IrregularBackendExecutionDependencies
} from './differential/irregularDifferential.js'
import { FreeMaterialServiceLive } from './freeMaterialService.js'
import { GeometryKernel, GeometrySettings } from './geometryKernel.js'
import { toIrregularWorkerFailure } from './irregularWorkerFailure.js'
import { NfpIfpServiceLive } from './nfpIfpService.js'
import { computeIrregularNestingNative } from './native/nativeIrregularBackend.js'
import { loadNativeIrregularAddon, probeNativeIrregularAddon } from './native/loadNativeBackend.js'
import { TransformGeneratorLive } from './transformGenerator.js'

export interface ProductionIrregularBackendInput {
  readonly backend: IrregularBackend
  readonly request: NestingRequest
  readonly settings?: IrregularNestingSettings
  readonly options?: ComputeIrregularNestingOptions
}

export interface NativeIrregularDiagnostics {
  readonly backendVersion: string
  readonly requestedThreadCount: number
  readonly actualThreadCount: number
  readonly nativeWallClockMs: number
  readonly raw: Readonly<Record<string, unknown>>
}

const productionIrregularBackendDependencies: IrregularBackendExecutionDependencies = {
  probeNative: probeNativeIrregularAddon,
  runRust: computeIrregularNestingNative,
  runTypeScript: (request, settings, options) =>
    computeIrregularNesting(request, options).pipe(
      Effect.provide(CollisionGeometryBuilder.Live),
      Effect.provide(TransformGeneratorLive),
      Effect.provide(NfpIfpServiceLive),
      Effect.provide(FreeMaterialServiceLive),
      Effect.provide(IrregularPlacementScorer.Layer),
      Effect.provide(IrregularLayoutScorer.Live),
      Effect.provide(GeometryKernel.Live),
      Effect.provide(Layer.succeed(GeometrySettings, settings)),
      Effect.mapError(toIrregularWorkerFailure)
    )
}

/** Executes an irregular request through the same production backend-selection seam as the worker. */
export function executeProductionIrregularBackend(
  input: ProductionIrregularBackendInput
): Effect.Effect<IrregularComputeResult, WorkerResponseFailureError> {
  const settings =
    input.settings ?? input.request.options.irregularSettings ?? GeometrySettings.Make
  return executeIrregularBackend({
    backend: input.backend,
    request: input.request,
    settings,
    ...(input.options === undefined ? {} : { options: input.options }),
    dependencies: productionIrregularBackendDependencies
  })
}

/** Reads the process-local diagnostics for the most recently completed native job. */
export function readLastNativeIrregularDiagnostics(): NativeIrregularDiagnostics | undefined {
  let encoded: string
  try {
    encoded = loadNativeIrregularAddon().getLastJobDiagnostics()
  } catch {
    return undefined
  }
  const decoded: unknown = JSON.parse(encoded)
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return undefined
  const raw = decoded as Record<string, unknown>
  const backendVersion = raw['backendVersion']
  const threadCountRequested = raw['threadCountRequested']
  const threadCountUsed = raw['threadCountUsed']
  const wallClockMs = raw['wallClockMs']
  if (
    typeof backendVersion !== 'string' ||
    typeof threadCountRequested !== 'number' ||
    !Number.isSafeInteger(threadCountRequested) ||
    threadCountRequested < 1 ||
    typeof threadCountUsed !== 'number' ||
    !Number.isSafeInteger(threadCountUsed) ||
    threadCountUsed < 1 ||
    typeof wallClockMs !== 'number' ||
    !Number.isFinite(wallClockMs) ||
    wallClockMs < 0
  ) {
    return undefined
  }
  return {
    backendVersion,
    requestedThreadCount: threadCountRequested,
    actualThreadCount: threadCountUsed,
    nativeWallClockMs: wallClockMs,
    raw
  }
}

export type { ComputeIrregularNestingOptions, IrregularComputeResult, IrregularStateSnapshot }
