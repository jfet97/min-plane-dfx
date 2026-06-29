import { Worker as NodeThreadWorker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Effect, Layer, ManagedRuntime, Stream } from 'effect'
import * as NodeWorker from '@effect/platform-node/NodeWorker'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import {
  NestingWorkerRpcs,
  type WorkerResponse,
  type WorkerProgress
} from '@shared/protocol/worker.js'
import type { NestingRequest, NestingResult } from '@shared/domain/nesting.js'
import type { JobId } from '@shared/domain/ids.js'
import type { NestingHistoryEvent, Unsubscribe } from '@shared/protocol/ipc.js'
import type { AppErrorCode } from '@shared/protocol/errors.js'

export type HistoryEventListener = (event: NestingHistoryEvent) => void

export interface WorkerSupervisorOptions {
  readonly workerPath: string
  readonly defaultTimeoutMs: number
}

interface PendingJob {
  readonly requestId: string
  readonly request: NestingRequest
  readonly resolve: (result: NestingResult) => void
  readonly reject: (err: SupervisorError) => void
  readonly listeners: Set<HistoryEventListener>
  readonly timer: NodeJS.Timeout
  readonly dispose: () => Promise<void>
}

/**
 * Errors surfaced by the supervisor to IPC handlers. Each one maps to an
 * AppErrorCode so the renderer can show a stable message.
 */
export class SupervisorError extends Error {
  readonly code: AppErrorCode
  readonly context?: Readonly<Record<string, unknown>>

  constructor(code: AppErrorCode, message: string, context?: Readonly<Record<string, unknown>>) {
    super(message)
    this.code = code
    if (context) this.context = context
  }
}

/**
 * Owns the worker thread lifecycle and serializes one job at a time.
 *
 * Phase 5 implementation:
 *   - One worker, lazily spawned on first job.
 *   - If the worker crashes, the active job fails with `worker_crashed` and
 *     the worker is replaced on the next call.
 *   - Timeout terminates the worker and rejects with `worker_timeout`.
 *   - History events are streamed to registered listeners in real time.
 *   - The final NestingResult is delivered both to the runNesting promise
 *     and via the result-event broadcast channel.
 *
 * The queue is intentionally simple: one active job at a time, but every
 * call gets its own worker instance if the previous one terminated. Future
 * versions can add a real concurrent pool without changing the public
 * surface.
 */
export class WorkerSupervisor {
  private current: PendingJob | null = null
  private readonly options: WorkerSupervisorOptions
  private readonly resultListeners = new Set<(jobId: JobId, result: NestingResult) => void>()

  constructor(options: WorkerSupervisorOptions) {
    this.options = options
  }

  /**
   * Subscribe to the final-result broadcast. Each handler is called once
   * per completed job. Returns an unsubscribe function.
   */
  onResult(handler: (jobId: JobId, result: NestingResult) => void): Unsubscribe {
    this.resultListeners.add(handler)
    return () => {
      this.resultListeners.delete(handler)
    }
  }

  /**
   * Run a NestingRequest, streaming history events to the listener as they
   * arrive. Resolves with the final NestingResult, or rejects with a
   * SupervisorError when the worker fails or times out.
   */
  runNesting(request: NestingRequest, listener: HistoryEventListener): Promise<NestingResult> {
    if (this.current) {
      return Promise.reject(
        new SupervisorError(
          'worker_crashed',
          'A nesting job is already running. Concurrency is intentionally not supported yet.',
          { jobId: this.current.request.jobId }
        )
      )
    }

    const requestId = cryptoRandomId()
    const listeners = new Set<HistoryEventListener>([listener])
    // Round 2 (F1 partial): honor the per-request timeout when present,
    // fall back to the supervisor default otherwise. The next round will
    // rewire this through an Effect race, but respecting the field now
    // removes a real divergence from NestingOptions.
    const timeoutMs =
      request.options.timeoutMs && request.options.timeoutMs > 0
        ? request.options.timeoutMs
        : this.options.defaultTimeoutMs

    console.info('[main:worker] starting worker job', {
      jobId: request.jobId,
      requestId,
      timeoutMs
    })

    return new Promise<NestingResult>((resolve, reject) => {
      const WorkerProtocolLive = RpcClient.layerProtocolWorker({ size: 1 }).pipe(
        Layer.provide(NodeWorker.layer(() => new NodeThreadWorker(this.options.workerPath)))
      )
      const runtime = ManagedRuntime.make(WorkerProtocolLive)
      const timer = setTimeout(() => {
        this.teardownWorker(runtime.dispose, 'timeout')
        this.current = null
        reject(
          new SupervisorError(
            'worker_timeout',
            `Worker exceeded the configured timeout of ${timeoutMs}ms.`,
            { requestId, jobId: request.jobId, timeoutMs }
          )
        )
      }, timeoutMs)

      this.current = {
        requestId,
        request,
        resolve,
        reject,
        listeners,
        timer,
        dispose: runtime.dispose
      }

      const handleWorkerMessage = this.handleWorkerMessage.bind(this)
      const program = Effect.gen(function* () {
        const client = yield* RpcClient.make(NestingWorkerRpcs)
        yield* Effect.scoped(
          client
            .RunNesting({ requestId, request })
            .pipe(Stream.runForEach((message) => Effect.sync(() => handleWorkerMessage(message))))
        )
      })

      void runtime.runPromise(Effect.scoped(program)).catch((err: unknown) => {
        this.handleWorkerError(err)
      })
    })
  }

  cancelJob(jobId: JobId): void {
    if (!this.current || this.current.request.jobId !== jobId) return
    const { dispose, timer } = this.current
    clearTimeout(timer)
    this.teardownWorker(dispose, 'cancel')
    this.current.reject(
      new SupervisorError('worker_cancelled', `Job ${jobId} cancelled by renderer request.`)
    )
    this.current = null
  }

  private teardownWorker(
    dispose: () => Promise<void>,
    _reason: 'cancel' | 'timeout' | 'success'
  ): void {
    void dispose().catch(() => undefined)
  }

  private handleWorkerMessage(parsed: WorkerResponse): void {
    if (!this.current) return

    if (parsed.type === 'history_frame' || parsed.type === 'history_complete') {
      const event = parsed as NestingHistoryEvent
      for (const listener of this.current.listeners) {
        try {
          listener(event)
        } catch (err) {
          // A misbehaving listener must not crash the worker pipeline.
          console.error('[WorkerSupervisor] history listener threw:', err)
        }
      }
      return
    }

    if (parsed.type === 'progress') {
      const progress: WorkerProgress = parsed.payload
      console.info('[main:worker] progress', {
        jobId: this.current.request.jobId,
        phase: progress.phase,
        at: progress.at
      })
      // Cancellation check: if the current request was already cancelled,
      // ignore the progress event.
      void progress
      return
    }

    if (parsed.type === 'success') {
      const result: NestingResult = parsed.payload
      const jobId = this.current.request.jobId
      console.info('[main:worker] success', {
        jobId,
        elapsedMs: result.stats.algorithm.elapsedMs,
        placed: result.placements.length,
        unplaced: result.unplacedPieceIds.length
      })
      clearTimeout(this.current.timer)
      this.teardownWorker(this.current.dispose, 'success')
      this.current.resolve(result)
      this.current = null
      for (const handler of this.resultListeners) {
        try {
          handler(jobId, result)
        } catch (err) {
          console.error('[WorkerSupervisor] result listener threw:', err)
        }
      }
      return
    }

    if (parsed.type === 'failure') {
      const code = parsed.error.code as AppErrorCode
      const message = parsed.error.message
      console.error('[main:worker] failure', {
        jobId: this.current.request.jobId,
        code,
        message
      })
      this.failCurrent(code, message)
      return
    }
  }

  private handleWorkerError(err: unknown): void {
    this.failCurrent('worker_crashed', err instanceof Error ? err.message : String(err))
  }

  private failCurrent(code: AppErrorCode, message: string): void {
    if (!this.current) return
    clearTimeout(this.current.timer)
    const err = new SupervisorError(code, message, { jobId: this.current.request.jobId })
    this.teardownWorker(this.current.dispose, 'cancel')
    this.current.reject(err)
    this.current = null
  }
}

function cryptoRandomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Default supervisor instance used by the IPC layer. */
export function createDefaultSupervisor(): WorkerSupervisor {
  // The compiled worker is shipped at out/main/index.js. Resolve the
  // bundled worker relative to that location so production runs find it.
  const here = dirname(fileURLToPath(import.meta.url))
  const workerPath = join(here, 'workers', 'nesting.worker.cjs')
  return new WorkerSupervisor({
    workerPath,
    defaultTimeoutMs: 60_000
  })
}
