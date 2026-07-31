import { Effect } from 'effect'
import type { JobId } from '@shared/domain/ids.js'
import {
  CancelNestingAcknowledgement,
  WorkerResponseFailureError,
  type CancelNestingPayload,
  type WorkerCancellationReason
} from '@shared/protocol/worker.js'

export interface ActiveRunController {
  readonly requestId: string
  readonly jobId: JobId
  readonly request: (reason: WorkerCancellationReason) => WorkerCancellationReason
  readonly reason: () => WorkerCancellationReason | undefined
  readonly isRequested: () => boolean
  readonly registerNativeCancellation: (
    cancel: (reason: WorkerCancellationReason) => void
  ) => void
}

function makeActiveRunController(requestId: string, jobId: JobId): ActiveRunController {
  let cancellationReason: WorkerCancellationReason | undefined
  let nativeCancellation: ((reason: WorkerCancellationReason) => void) | undefined
  let nativeCancellationInvoked = false

  const invokeNativeCancellation = (): void => {
    if (
      nativeCancellationInvoked ||
      nativeCancellation === undefined ||
      cancellationReason === undefined
    ) {
      return
    }
    nativeCancellationInvoked = true
    try {
      nativeCancellation(cancellationReason)
    } catch {
      // cancellation remains requested; the supervisor grace watchdog is the fallback
    }
  }

  return {
    requestId,
    jobId,
    request: (reason) => {
      cancellationReason ??= reason
      invokeNativeCancellation()
      return cancellationReason
    },
    reason: () => cancellationReason,
    isRequested: () => cancellationReason !== undefined,
    registerNativeCancellation: (cancel) => {
      if (nativeCancellation !== undefined || nativeCancellationInvoked) return
      nativeCancellation = cancel
      if (cancellationReason !== undefined) invokeNativeCancellation()
    }
  }
}

export class ActiveRunRegistry {
  private readonly controllers = new Map<string, ActiveRunController>()

  start(requestId: string, jobId: JobId): ActiveRunController {
    if (this.controllers.has(requestId)) {
      throw new Error(`An active nesting run already exists for request ${requestId}.`)
    }
    const controller = makeActiveRunController(requestId, jobId)
    this.controllers.set(requestId, controller)
    return controller
  }

  request(payload: CancelNestingPayload): CancelNestingAcknowledgement {
    const controller = this.controllers.get(payload.requestId)
    if (controller === undefined || controller.jobId !== payload.jobId) {
      return new CancelNestingAcknowledgement({
        requestId: payload.requestId,
        jobId: payload.jobId,
        accepted: false
      })
    }

    return new CancelNestingAcknowledgement({
      requestId: payload.requestId,
      jobId: payload.jobId,
      accepted: true,
      activeReason: controller.request(payload.reason)
    })
  }

  finish(controller: ActiveRunController): void {
    if (this.controllers.get(controller.requestId) === controller) {
      this.controllers.delete(controller.requestId)
    }
  }
}

export function workerCancellationFailure(
  controller: ActiveRunController
): WorkerResponseFailureError | undefined {
  const reason = controller.reason()
  if (reason === undefined) return undefined
  return new WorkerResponseFailureError({
    code: reason === 'cancelled' ? 'worker_cancelled' : 'worker_timeout',
    message:
      reason === 'cancelled'
        ? `Job ${controller.jobId} cancelled by renderer request.`
        : `Job ${controller.jobId} exceeded its configured timeout.`,
    context: { reason }
  })
}

export function cancelActiveRunOnInterrupt<A, E, R>(
  controller: ActiveRunController,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return effect.pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        controller.request('cancelled')
      })
    )
  )
}
