import type { IrregularBackend } from '@shared/irregular/backendSelection.js'
import { intrinsicSharedArchiveEligibility } from '@shared/irregular/executionMode.js'
import type { NestingRequest } from '@shared/domain/nesting.js'
import type { IrregularNestingSettings } from '@shared/irregular/domain.js'
import { WorkerResponseFailureError } from '@shared/protocol/worker.js'
import { Effect } from 'effect'
import type {
  ComputeIrregularNestingOptions,
  IrregularComputeResult
} from '../../algorithm/irregular/computeIrregularNesting.js'
import type { NativeIrregularBackendOptions } from '../native/nativeIrregularBackend.js'
import type { NativeCapabilityProbe } from '../native/loadNativeBackend.js'
import {
  boundedIrregularDifferentialValue,
  compareIrregularDifferentialOutcomes,
  type IrregularDifferentialOutcome
} from './irregularSemanticComparison.js'

export interface IrregularBackendExecutionDependencies {
  readonly probeNative: () => NativeCapabilityProbe
  readonly runTypeScript: (
    request: NestingRequest,
    settings: IrregularNestingSettings,
    options?: ComputeIrregularNestingOptions
  ) => Effect.Effect<IrregularComputeResult, WorkerResponseFailureError>
  readonly runRust: (
    request: NestingRequest,
    settings: IrregularNestingSettings,
    options?: NativeIrregularBackendOptions
  ) => Effect.Effect<IrregularComputeResult, WorkerResponseFailureError>
}

export interface IrregularBackendExecutionInput {
  readonly backend: IrregularBackend
  readonly request: NestingRequest
  readonly settings: IrregularNestingSettings
  readonly options?: ComputeIrregularNestingOptions
  readonly dependencies: IrregularBackendExecutionDependencies
}

function nativeOptions(
  options: ComputeIrregularNestingOptions | undefined
): NativeIrregularBackendOptions | undefined {
  if (options === undefined) return undefined
  const adapted: NativeIrregularBackendOptions = {
    ...(options.emitStateSnapshot === undefined
      ? {}
      : { emitStateSnapshot: options.emitStateSnapshot }),
    ...(options.emitPortfolioProgress === undefined
      ? {}
      : { emitPortfolioProgress: options.emitPortfolioProgress }),
    ...(options.isCancelled === undefined ? {} : { isCancelled: options.isCancelled }),
    ...(options.registerNativeCancellation === undefined
      ? {}
      : { registerNativeCancellation: options.registerNativeCancellation })
  }
  return Object.keys(adapted).length === 0 ? undefined : adapted
}

function silentNativeOptions(
  options: ComputeIrregularNestingOptions | undefined
): NativeIrregularBackendOptions | undefined {
  if (options === undefined) return undefined
  const adapted: NativeIrregularBackendOptions = {
    ...(options.isCancelled === undefined ? {} : { isCancelled: options.isCancelled }),
    ...(options.registerNativeCancellation === undefined
      ? {}
      : { registerNativeCancellation: options.registerNativeCancellation })
  }
  return Object.keys(adapted).length === 0 ? undefined : adapted
}

function nativeUnavailableFailure(
  requestedBackend: 'auto' | 'rust' | 'differential',
  probe: Extract<NativeCapabilityProbe, { available: false }>
): WorkerResponseFailureError {
  return new WorkerResponseFailureError({
    code: 'worker_protocol_error',
    message: `irregular-nesting-native addon unavailable (${probe.reason}): ${probe.detail}`,
    context: { requestedBackend, reason: probe.reason }
  })
}

function nativeIneligibleFailure(
  requestedBackend: 'rust' | 'differential',
  reason: string
): WorkerResponseFailureError {
  return new WorkerResponseFailureError({
    code: 'worker_protocol_error',
    message:
      `The explicitly requested ${requestedBackend} irregular backend is ineligible for this request ` +
      `(reason: ${reason}). Rust supports only archive-eligible Compact and Compact Short Side jobs.`,
    context: { requestedBackend, reason }
  })
}

function requiredNativeProfile(settings: IrregularNestingSettings): string {
  return settings.optimizer.intrinsicObjectiveProfileId === 'short-side'
    ? 'compact-short-side'
    : 'compact'
}

function nativeProfileMismatchFailure(
  requestedBackend: 'auto' | 'rust' | 'differential',
  requiredProfile: string,
  advertisedProfiles: ReadonlyArray<string>
): WorkerResponseFailureError {
  return new WorkerResponseFailureError({
    code: 'worker_protocol_error',
    message:
      `irregular-nesting-native capability does not advertise required profile ` +
      `'${requiredProfile}' (requested ${requestedBackend}; advertised ` +
      `${advertisedProfiles.length === 0 ? '(none)' : advertisedProfiles.join(', ')}).`,
    context: {
      requestedBackend,
      reason: 'profile-mismatch',
      requiredProfile,
      advertisedProfiles: [...advertisedProfiles]
    }
  })
}

function mismatchFailure(
  typescript: IrregularDifferentialOutcome,
  rust: IrregularDifferentialOutcome
): WorkerResponseFailureError | undefined {
  const divergence = compareIrregularDifferentialOutcomes(typescript, rust)
  if (divergence === undefined) return undefined

  return new WorkerResponseFailureError({
    code: 'irregular_differential_mismatch',
    message: `TypeScript and Rust irregular backends diverged at ${divergence.path}.`,
    context: {
      path: divergence.path,
      typescriptValue: boundedIrregularDifferentialValue(divergence.typescript),
      rustValue: boundedIrregularDifferentialValue(divergence.rust)
    }
  })
}

function captureOutcome(
  effect: Effect.Effect<IrregularComputeResult, WorkerResponseFailureError>
): Effect.Effect<IrregularDifferentialOutcome> {
  return effect.pipe(
    Effect.match({
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: (value) => ({ ok: true as const, value })
    })
  )
}

/**
 * Executes the selected irregular backend. Auto uses TypeScript for
 * archive-ineligible jobs and otherwise requires a matching native profile
 * before dispatching Rust. TypeScript remains the authority in differential
 * mode: it observes callbacks, runs Rust silently second, compares complete
 * semantic outcomes, and returns the original TypeScript outcome only when
 * both projections are equal.
 */
export function executeIrregularBackend(
  input: IrregularBackendExecutionInput
): Effect.Effect<IrregularComputeResult, WorkerResponseFailureError> {
  const { backend, request, settings, options, dependencies } = input
  if (backend === 'typescript') {
    return dependencies.runTypeScript(request, settings, options)
  }

  const eligibility = intrinsicSharedArchiveEligibility(settings.optimizer)
  if (!eligibility.eligible) {
    if (backend === 'auto') {
      return dependencies.runTypeScript(request, settings, options)
    }
    return Effect.fail(nativeIneligibleFailure(backend, eligibility.reason))
  }

  const probe = dependencies.probeNative()
  if (!probe.available) {
    return Effect.fail(nativeUnavailableFailure(backend, probe))
  }

  const requiredProfile = requiredNativeProfile(settings)
  if (!probe.profiles.includes(requiredProfile)) {
    return Effect.fail(nativeProfileMismatchFailure(backend, requiredProfile, probe.profiles))
  }

  if (backend === 'auto' || backend === 'rust') {
    return dependencies.runRust(request, settings, nativeOptions(options))
  }

  return Effect.gen(function* () {
    const typescript = yield* captureOutcome(dependencies.runTypeScript(request, settings, options))
    const rust = yield* captureOutcome(
      dependencies.runRust(request, settings, silentNativeOptions(options))
    )
    const mismatch = mismatchFailure(typescript, rust)
    if (mismatch !== undefined) return yield* Effect.fail(mismatch)

    if (typescript.ok) return typescript.value
    return yield* Effect.fail(typescript.error)
  })
}

export function computeIrregularNestingDifferential(
  input: Omit<IrregularBackendExecutionInput, 'backend'>
): Effect.Effect<IrregularComputeResult, WorkerResponseFailureError> {
  return executeIrregularBackend({ ...input, backend: 'differential' })
}
