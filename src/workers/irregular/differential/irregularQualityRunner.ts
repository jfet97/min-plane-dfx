import { Effect } from 'effect'
import type { NestingRequest } from '@shared/domain/nesting.js'
import type { IrregularNestingSettings, IrregularPreparedPiece } from '@shared/irregular/domain.js'
import type { WorkerResponseFailureError } from '@shared/protocol/worker.js'
import type {
  ComputeIrregularNestingOptions,
  IrregularComputeResult
} from '../../algorithm/irregular/computeIrregularNesting.js'
import type { NativeIrregularBackendOptions } from '../native/nativeIrregularBackend.js'
import {
  assertIrregularQualityPolicy,
  classifyIrregularQualityDifferential,
  makeIrregularQualityFacts,
  type IrregularCohesionEvidence,
  type IrregularQualityDifferentialResult,
  type IrregularQualityPolicy,
  type IrregularShortSideAuthoritativeEvidence
} from './irregularQualityAcceptance.js'
import {
  compareIrregularDifferentialOutcomes,
  type IrregularDifferentialOutcome
} from './irregularSemanticComparison.js'

export interface IrregularQualityAcceptanceDependencies {
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

export interface IrregularQualityAcceptanceInput {
  readonly request: NestingRequest
  readonly settings: IrregularNestingSettings
  readonly options?: ComputeIrregularNestingOptions
  readonly nativeOptions?: NativeIrregularBackendOptions
  readonly objectiveProfile: 'compact' | 'short-side'
  readonly policy: IrregularQualityPolicy
  /** Caller-owned prepared geometry authority captured from the production preparation seam. */
  readonly geometryAuthority: ReadonlyArray<IrregularPreparedPiece>
  /** Optional late-bound authority used when preparation occurs inside the TypeScript run. */
  readonly geometryAuthorityProvider?: () => ReadonlyArray<IrregularPreparedPiece>
  /** Caller-owned production Short Side geometry used to derive directional references. */
  readonly shortSideAuthority?: IrregularShortSideAuthoritativeEvidence
  /** Optional late-bound production geometry captured by the TypeScript observer seam. */
  readonly shortSideAuthorityProvider?: () => IrregularShortSideAuthoritativeEvidence | undefined
  readonly cohesionEvidence?: {
    readonly typescript?: IrregularCohesionEvidence
    readonly rust?: IrregularCohesionEvidence
  }
  readonly dependencies: IrregularQualityAcceptanceDependencies
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

/** Runs both backends sequentially and classifies complete success-or-failure outcomes. */
export function executeIrregularQualityAcceptance(
  input: IrregularQualityAcceptanceInput
): Effect.Effect<IrregularQualityDifferentialResult, WorkerResponseFailureError> {
  return Effect.gen(function* () {
    assertIrregularQualityPolicy(input.policy)
    if (input.policy.objectiveProfile !== input.objectiveProfile) {
      throw new Error(
        `Quality policy profile ${input.policy.objectiveProfile} does not match ${input.objectiveProfile}.`
      )
    }
    const typescript = yield* captureOutcome(
      input.dependencies.runTypeScript(input.request, input.settings, input.options)
    )
    const rust = yield* captureOutcome(
      input.dependencies.runRust(input.request, input.settings, input.nativeOptions)
    )
    const geometryAuthority = input.geometryAuthorityProvider?.() ?? input.geometryAuthority
    const shortSideAuthority = input.shortSideAuthorityProvider?.() ?? input.shortSideAuthority
    const semanticDivergence = compareIrregularDifferentialOutcomes(typescript, rust)
    return classifyIrregularQualityDifferential({
      semanticDivergence,
      typescript: typescript.ok
        ? {
            ok: true,
            facts: makeIrregularQualityFacts({
              backend: 'typescript',
              request: input.request,
              result: typescript.value,
              policy: input.policy,
              geometryAuthority,
              ...(shortSideAuthority === undefined ? {} : { shortSideAuthority }),
              ...(input.cohesionEvidence?.typescript === undefined
                ? {}
                : { cohesionEvidence: input.cohesionEvidence.typescript })
            })
          }
        : typescript,
      rust: rust.ok
        ? {
            ok: true,
            facts: makeIrregularQualityFacts({
              backend: 'rust',
              request: input.request,
              result: rust.value,
              policy: input.policy,
              geometryAuthority,
              ...(shortSideAuthority === undefined ? {} : { shortSideAuthority }),
              ...(input.cohesionEvidence?.rust === undefined
                ? {}
                : { cohesionEvidence: input.cohesionEvidence.rust })
            })
          }
        : rust,
      policy: input.policy
    })
  })
}
