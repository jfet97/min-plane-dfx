import { Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'
import { JobId } from '@shared/domain/ids.js'
import { CancelNestingPayload } from '@shared/protocol/worker.js'
import {
  ActiveRunRegistry,
  cancelActiveRunOnInterrupt,
  workerCancellationFailure
} from '../../src/workers/activeRunController.js'

const jobId = JobId.make('job-1')

describe('worker active-run cancellation controller', () => {
  it('ignores stale request IDs and mismatched public job IDs', () => {
    const registry = new ActiveRunRegistry()
    const controller = registry.start('request-1', jobId)

    const stale = registry.request(
      new CancelNestingPayload({
        requestId: 'stale-request',
        jobId,
        reason: 'cancelled'
      })
    )
    const mismatched = registry.request(
      new CancelNestingPayload({
        requestId: 'request-1',
        jobId: JobId.make('other-job'),
        reason: 'timeout'
      })
    )

    expect(stale).toMatchObject({ accepted: false })
    expect(mismatched).toMatchObject({ accepted: false })
    expect(controller.isRequested()).toBe(false)
  })

  it('keeps the first cancellation reason and acknowledges later requests idempotently', () => {
    const registry = new ActiveRunRegistry()
    const controller = registry.start('request-1', jobId)

    const first = registry.request(
      new CancelNestingPayload({ requestId: 'request-1', jobId, reason: 'cancelled' })
    )
    const second = registry.request(
      new CancelNestingPayload({ requestId: 'request-1', jobId, reason: 'timeout' })
    )

    expect(first).toMatchObject({ accepted: true, activeReason: 'cancelled' })
    expect(second).toMatchObject({ accepted: true, activeReason: 'cancelled' })
    expect(controller.reason()).toBe('cancelled')
  })

  it('replays the first cancellation reason to one-shot native registration exactly once', () => {
    const registry = new ActiveRunRegistry()
    const controller = registry.start('request-1', jobId)
    let nativeCancellationCount = 0
    let nativeCancellationReason: 'cancelled' | 'timeout' | undefined

    controller.request('timeout')
    controller.registerNativeCancellation((reason) => {
      nativeCancellationCount += 1
      nativeCancellationReason = reason
    })
    controller.registerNativeCancellation(() => {
      nativeCancellationCount += 10
    })
    controller.request('cancelled')

    expect(nativeCancellationCount).toBe(1)
    expect(nativeCancellationReason).toBe('timeout')
    expect(controller.reason()).toBe('timeout')
  })

  it('keeps the typed acknowledgement when native cancellation throws', () => {
    const registry = new ActiveRunRegistry()
    const controller = registry.start('request-1', jobId)
    controller.registerNativeCancellation(() => {
      throw new Error('native cancellation transport failed')
    })

    expect(() =>
      registry.request(
        new CancelNestingPayload({ requestId: 'request-1', jobId, reason: 'cancelled' })
      )
    ).not.toThrow()
    expect(controller.reason()).toBe('cancelled')
  })

  it('maps the first cancellation reason to the typed terminal worker failure', () => {
    const registry = new ActiveRunRegistry()
    const controller = registry.start('request-1', jobId)
    controller.request('timeout')

    expect(workerCancellationFailure(controller)).toMatchObject({
      code: 'worker_timeout',
      context: { reason: 'timeout' }
    })
  })

  it('routes Effect interruption through the same idempotent controller', async () => {
    const registry = new ActiveRunRegistry()
    const controller = registry.start('request-1', jobId)
    let nativeCancellationCount = 0
    controller.registerNativeCancellation(() => {
      nativeCancellationCount += 1
    })

    const fiber = Effect.runFork(cancelActiveRunOnInterrupt(controller, Effect.never))
    await Effect.runPromise(Fiber.interrupt(fiber))
    controller.request('timeout')

    expect(controller.reason()).toBe('cancelled')
    expect(nativeCancellationCount).toBe(1)
  })
})
