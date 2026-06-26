import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Exit, Schema } from 'effect'
import {
  WorkerRequest,
  WorkerResponse,
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
  readonly worker: Worker
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
  runNesting(
    request: NestingRequest,
    listener: HistoryEventListener
  ): Promise<NestingResult> {
    if (this.current) {
      return Promise.reject(
        new SupervisorError(
          'worker_crashed',
          'A nesting job is already running. Concurrency is intentionally not supported yet.',
          { jobId: this.current.request.jobId }
        )
      )
    }

    const worker = new Worker(this.options.workerPath)
    const requestId = cryptoRandomId()
    const listeners = new Set<HistoryEventListener>([listener])

    return new Promise<NestingResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.teardownWorker(worker, 'timeout')
        this.current = null
        reject(
          new SupervisorError(
            'worker_timeout',
            `Worker exceeded the configured timeout of ${this.options.defaultTimeoutMs}ms.`,
            { requestId, jobId: request.jobId }
          )
        )
      }, this.options.defaultTimeoutMs)

      this.current = {
        requestId,
        request,
        resolve,
        reject,
        listeners,
        timer,
        worker
      }

      worker.on('message', (raw: unknown) => this.handleWorkerMessage(raw))
      worker.on('error', (err) => this.handleWorkerError(err))
      worker.on('exit', (code) => this.handleWorkerExit(code))

      const req: WorkerRequest = {
        type: 'run_nesting',
        requestId,
        payload: request
      }
      worker.postMessage(req)
    })
  }

  cancelJob(jobId: JobId): void {
    if (!this.current || this.current.request.jobId !== jobId) return
    const { worker, timer } = this.current
    clearTimeout(timer)
    this.teardownWorker(worker, 'cancel')
    this.current.reject(
      new SupervisorError('worker_cancelled', `Job ${jobId} cancelled by renderer request.`)
    )
    this.current = null
  }

  private teardownWorker(worker: Worker, _reason: 'cancel' | 'timeout' | 'success'): void {
    void worker.terminate().catch(() => undefined)
  }

  private handleWorkerMessage(raw: unknown): void {
    if (!this.current) return
    // Validate each inbound message at the boundary.
    const exit = Schema.decodeUnknownExit(WorkerResponse)(raw)
    if (Exit.isFailure(exit)) {
      this.failCurrent('worker_protocol_error', 'Worker emitted an invalid response.')
      return
    }
    const parsed: WorkerResponse = exit.value

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
      // Cancellation check: if the current request was already cancelled,
      // ignore the progress event.
      void progress
      return
    }

    if (parsed.type === 'success') {
      const result: NestingResult = parsed.payload
      const jobId = this.current.request.jobId
      clearTimeout(this.current.timer)
      this.teardownWorker(this.current.worker, 'success')
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
      this.failCurrent(code, message)
      return
    }
  }

  private handleWorkerError(err: Error): void {
    this.failCurrent('worker_crashed', err.message)
  }

  private handleWorkerExit(code: number): void {
    if (!this.current) return
    if (code !== 0) {
      this.failCurrent('worker_crashed', `Worker exited with code ${code}.`)
    }
  }

  private failCurrent(code: AppErrorCode, message: string): void {
    if (!this.current) return
    clearTimeout(this.current.timer)
    const err = new SupervisorError(code, message, { jobId: this.current.request.jobId })
    this.teardownWorker(this.current.worker, 'cancel')
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