import { Effect } from 'effect'
import { IRREGULAR_WORKER_MODE } from '@shared/irregular/defaults.js'
import type {
  NestingHistoryFramePayload,
  NestingRequest,
  NestingResult
} from '@shared/domain/nesting.js'
import type { IrregularPortfolioProgress } from '@shared/irregular/domain.js'
import type { WorkerResponseFailureError } from '@shared/protocol/worker.js'
import type { ComputeNestingOptions } from './algorithm/computeNesting.js'
import type { IrregularDecisionTraceEvent } from './algorithm/irregular/decisionTrace.js'
import type { ActiveRunController } from './activeRunController.js'

export interface NestingWorkerDispatchDependencies {
  readonly computeNesting: (
    request: NestingRequest,
    options: ComputeNestingOptions
  ) => NestingResult
  readonly computeIrregular: (
    request: NestingRequest,
    emitFrame: ((frame: NestingHistoryFramePayload) => void) | undefined,
    emitPortfolioProgress:
      | ((progress: IrregularPortfolioProgress) => Effect.Effect<void>)
      | undefined,
    emitDecisionTrace: ((event: IrregularDecisionTraceEvent) => void) | undefined,
    controller: ActiveRunController
  ) => Effect.Effect<NestingResult, WorkerResponseFailureError>
}

export interface NestingWorkerDispatchInput {
  readonly request: NestingRequest
  readonly emitFrame: (frame: NestingHistoryFramePayload) => void
  readonly irregularEmitFrame: ((frame: NestingHistoryFramePayload) => void) | undefined
  readonly emitPortfolioProgress:
    | ((progress: IrregularPortfolioProgress) => Effect.Effect<void>)
    | undefined
  readonly emitDecisionTrace: ((event: IrregularDecisionTraceEvent) => void) | undefined
  readonly controller: ActiveRunController
  readonly dependencies: NestingWorkerDispatchDependencies
}

export function dispatchNestingComputation(
  input: NestingWorkerDispatchInput
): Effect.Effect<NestingResult, WorkerResponseFailureError> {
  const { request, dependencies } = input
  if (request.options.workerMode === IRREGULAR_WORKER_MODE) {
    return dependencies.computeIrregular(
      request,
      input.irregularEmitFrame,
      input.emitPortfolioProgress,
      input.emitDecisionTrace,
      input.controller
    )
  }

  return Effect.sync(() =>
    dependencies.computeNesting(request, {
      emitFrame: input.emitFrame
    })
  )
}
