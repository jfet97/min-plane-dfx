import { Worker as NodeThreadWorker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Effect, Layer, ManagedRuntime, Stream } from 'effect'
import * as NodeWorker from '@effect/platform-node/NodeWorker'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import {
  NestingWorkerRpcs,
  WorkerProgress,
  WorkerProgressResponse,
  type WorkerResponse
} from '@shared/protocol/worker.js'
import { NestingResult as NestingResultModel } from '@shared/domain/nesting.js'
import type {
  NestingHistorySummary,
  NestingRequest,
  NestingResult
} from '@shared/domain/nesting.js'
import type { JobId } from '@shared/domain/ids.js'
import type { NestingHistoryEvent, Unsubscribe } from '@shared/protocol/ipc.js'
import type { AppErrorCode } from '@shared/protocol/errors.js'

export type HistoryEventListener = (event: NestingHistoryEvent) => void

export interface WorkerSupervisorOptions {
  readonly workerPath: string
  readonly historyDirectory: string
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
  historySummary: NestingHistorySummary | null
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

    return new Promise<NestingResult>((resolve, reject) => {
      const WorkerProtocolLive = RpcClient.layerProtocolWorker({ size: 1 }).pipe(
        Layer.provide(NodeWorker.layer(() => this.makeWorkerThread(requestId, request.jobId)))
      )
      const runtime = ManagedRuntime.make(WorkerProtocolLive)
      const timer = setTimeout(() => {
        const current = this.current
        if (
          current === null ||
          current.requestId !== requestId ||
          current.request.jobId !== request.jobId
        ) {
          return
        }
        this.dispatchEvent(
          current,
          cancellationProgress(current)
        )
        clearTimeout(current.timer)
        this.teardownWorker(current.dispose, 'timeout')
        current.reject(
          new SupervisorError(
            'worker_timeout',
            `Worker exceeded the configured timeout of ${timeoutMs}ms.`,
            { requestId, jobId: request.jobId, timeoutMs }
          )
        )
        this.current = null
      }, timeoutMs)

      this.current = {
        requestId,
        request,
        resolve,
        reject,
        listeners,
        timer,
        dispose: runtime.dispose,
        historySummary: null
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
        this.handleWorkerError(requestId, request.jobId, err)
      })
    })
  }

  cancelJob(jobId: JobId): void {
    if (!this.current || this.current.request.jobId !== jobId) return
    const current = this.current
    this.dispatchEvent(
      current,
      cancellationProgress(current)
    )
    clearTimeout(current.timer)
    this.teardownWorker(current.dispose, 'cancel')
    current.reject(
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

  private makeWorkerThread(requestId: string, jobId: JobId): NodeThreadWorker {
    const worker = new NodeThreadWorker(this.options.workerPath, {
      env: {
        ...process.env,
        MIN_PLANE_HISTORY_DIR: this.options.historyDirectory
      },
      stdout: true,
      stderr: true
    })
    worker.once('error', (error) => {
      console.error('[main:worker] thread error', {
        jobId,
        requestId,
        message: error.message,
        stack: error.stack
      })
    })
    worker.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(`[worker:stdout] ${chunk.toString()}`)
    })
    worker.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[worker:stderr] ${chunk.toString()}`)
    })
    return worker
  }

  private handleWorkerMessage(parsed: WorkerResponse): void {
    const current = this.current
    if (
      current === null ||
      current.requestId !== parsed.requestId ||
      (parsed.jobId !== undefined && current.request.jobId !== parsed.jobId)
    ) {
      return
    }

    if (parsed.type === 'history_frame') {
      this.dispatchEvent(current, parsed)
      return
    }

    if (parsed.type === 'history_complete') {
      current.historySummary = parsed.payload
      this.dispatchEvent(current, parsed)
      return
    }

    if (parsed.type === 'progress') {
      this.dispatchEvent(current, parsed)
      return
    }

    if (parsed.type === 'success') {
      const result: NestingResult = current.historySummary
        ? new NestingResultModel({
            ...parsed.payload,
            historySummary: current.historySummary
          })
        : parsed.payload
      const jobId = current.request.jobId
      clearTimeout(current.timer)
      this.teardownWorker(current.dispose, 'success')
      current.resolve(result)
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
      const code: AppErrorCode = parsed.error.code
      const message = parsed.error.message
      console.error('[main:worker] failure', {
        jobId: current.request.jobId,
        code,
        message
      })
      this.failCurrent(code, message, parsed.error.context)
      return
    }
  }

  private dispatchEvent(
    current: PendingJob,
    event: NestingHistoryEvent
  ): void {
    for (const listener of current.listeners) {
      try {
        listener(event)
      } catch (err) {
        // a misbehaving listener must not crash the worker pipeline
        console.error('[WorkerSupervisor] history listener threw:', err)
      }
    }
  }

  private handleWorkerError(requestId: string, jobId: JobId, err: unknown): void {
    const current = this.current
    if (
      current === null ||
      current.requestId !== requestId ||
      current.request.jobId !== jobId
    ) {
      return
    }
    this.failCurrent('worker_crashed', err instanceof Error ? err.message : String(err))
  }

  private failCurrent(
    code: AppErrorCode,
    message: string,
    context: Readonly<Record<string, unknown>> = {}
  ): void {
    if (!this.current) return
    clearTimeout(this.current.timer)
    const err = new SupervisorError(code, message, { jobId: this.current.request.jobId, ...context })
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

function cancellationProgress(current: PendingJob): WorkerProgressResponse {
  return new WorkerProgressResponse({
    requestId: current.requestId,
    jobId: current.request.jobId,
    payload: new WorkerProgress({ phase: 'cancelled', at: new Date().toISOString() })
  })
}

/** Default supervisor instance used by the IPC layer. */
export function createDefaultSupervisor(): WorkerSupervisor {
  // The compiled worker is shipped at out/main/index.js. Resolve the
  // bundled worker relative to that location so production runs find it.
  const here = dirname(fileURLToPath(import.meta.url))
  const workerPath = join(here, 'workers', 'nesting.worker.mjs')
  return new WorkerSupervisor({
    workerPath,
    historyDirectory: process.env['MIN_PLANE_HISTORY_DIR'] ?? join(here, 'history'),
    defaultTimeoutMs: 60_000
  })
}
