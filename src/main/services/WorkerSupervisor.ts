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
  type CancelNestingAcknowledgement,
  type CancelNestingPayload,
  type WorkerCancellationReason,
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

/** One active stream plus its cancellation control request on the same worker. */
export const WORKER_RPC_POOL_OPTIONS = { size: 1, concurrency: 2 } as const

export interface WorkerSupervisorSessionFactoryInput {
  readonly requestId: string
  readonly request: NestingRequest
  readonly onMessage: (message: WorkerResponse) => void
}

export interface WorkerSupervisorSession {
  readonly start: (input: WorkerSupervisorSessionFactoryInput) => Promise<void>
  readonly cancel: (payload: CancelNestingPayload) => Promise<CancelNestingAcknowledgement>
  readonly dispose: () => Promise<void>
}

export interface WorkerSupervisorOptions {
  readonly workerPath: string
  readonly historyDirectory: string
  readonly defaultTimeoutMs: number
  readonly cancellationGraceMs?: number
  readonly sessionFactory?: (requestId: string, jobId: JobId) => WorkerSupervisorSession
}

interface PendingJob {
  readonly requestId: string
  readonly request: NestingRequest
  readonly resolve: (result: NestingResult) => void
  readonly reject: (err: SupervisorError) => void
  readonly listeners: Set<HistoryEventListener>
  readonly session: WorkerSupervisorSession
  readonly timer: NodeJS.Timeout
  graceTimer: NodeJS.Timeout | null
  cancellationReason: WorkerCancellationReason | null
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
 *   - Cancellation and timeout use a typed control RPC and drain the stream.
 *   - Worker disposal is a bounded fallback after the cancellation grace period.
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
    const timeoutMs =
      request.options.timeoutMs && request.options.timeoutMs > 0
        ? request.options.timeoutMs
        : this.options.defaultTimeoutMs

    return new Promise<NestingResult>((resolve, reject) => {
      const session =
        this.options.sessionFactory?.(requestId, request.jobId) ??
        this.makeRpcSession(requestId, request.jobId)
      const timer = setTimeout(() => {
        this.requestCancellation(requestId, request.jobId, 'timeout', timeoutMs)
      }, timeoutMs)

      this.current = {
        requestId,
        request,
        resolve,
        reject,
        listeners,
        session,
        timer,
        graceTimer: null,
        cancellationReason: null,
        historySummary: null
      }

      void session
        .start({
          requestId,
          request,
          onMessage: (message) => this.handleWorkerMessage(message)
        })
        .then(() => this.handleWorkerStreamEnd(requestId, request.jobId))
        .catch((err: unknown) => {
          this.handleWorkerError(requestId, request.jobId, err)
        })
    })
  }

  cancelJob(jobId: JobId): void {
    const current = this.current
    if (current === null || current.request.jobId !== jobId) return
    this.requestCancellation(current.requestId, jobId, 'cancelled')
  }

  private teardownWorker(session: WorkerSupervisorSession): void {
    void session.dispose().catch(() => undefined)
  }

  private makeRpcSession(requestId: string, jobId: JobId): WorkerSupervisorSession {
    const WorkerProtocolLive = RpcClient.layerProtocolWorker(WORKER_RPC_POOL_OPTIONS).pipe(
      Layer.provide(NodeWorker.layer(() => this.makeWorkerThread(requestId, jobId)))
    )
    const runtime = ManagedRuntime.make(WorkerProtocolLive)
    let startCalled = false
    let resolveCancel:
      | ((cancel: (payload: CancelNestingPayload) => Promise<CancelNestingAcknowledgement>) => void)
      | undefined
    let rejectCancel: ((error: unknown) => void) | undefined
    const cancelReady = new Promise<
      (payload: CancelNestingPayload) => Promise<CancelNestingAcknowledgement>
    >((resolve, reject) => {
      resolveCancel = resolve
      rejectCancel = reject
    })

    return {
      start: ({ requestId: activeRequestId, request, onMessage }) => {
        if (startCalled) return Promise.reject(new Error('Worker session already started.'))
        startCalled = true
        const program = Effect.gen(function* () {
          const client = yield* RpcClient.make(NestingWorkerRpcs)
          resolveCancel?.((payload) => runtime.runPromise(client.CancelNesting(payload)))
          yield* client
            .RunNesting({ requestId: activeRequestId, request })
            .pipe(Stream.runForEach((message) => Effect.sync(() => onMessage(message))))
        })
        return runtime.runPromise(Effect.scoped(program)).catch((error: unknown) => {
          rejectCancel?.(error)
          throw error
        })
      },
      cancel: async (payload) => {
        const cancel = await cancelReady
        return cancel(payload)
      },
      dispose: runtime.dispose
    }
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

  private requestCancellation(
    requestId: string,
    jobId: JobId,
    reason: WorkerCancellationReason,
    timeoutMs?: number
  ): void {
    const current = this.current
    if (
      current === null ||
      current.requestId !== requestId ||
      current.request.jobId !== jobId ||
      current.cancellationReason !== null
    ) {
      return
    }

    current.cancellationReason = reason
    clearTimeout(current.timer)
    this.dispatchEvent(current, cancellationProgress(current))
    void current.session.cancel({ requestId, jobId, reason }).catch((error: unknown) => {
      console.error('[main:worker] cancellation control failed', {
        requestId,
        jobId,
        reason,
        message: error instanceof Error ? error.message : String(error)
      })
    })

    const graceMs = this.options.cancellationGraceMs ?? 2_000
    current.graceTimer = setTimeout(() => {
      const active = this.current
      if (
        active === null ||
        active.requestId !== requestId ||
        active.request.jobId !== jobId ||
        active.cancellationReason !== reason
      ) {
        return
      }
      const code = reason === 'cancelled' ? 'worker_cancelled' : 'worker_timeout'
      const message =
        reason === 'cancelled'
          ? `Job ${jobId} cancelled by renderer request.`
          : `Worker exceeded the configured timeout of ${timeoutMs ?? active.request.options.timeoutMs}ms.`
      this.failCurrent(code, message, {
        requestId,
        reason,
        cancellationGraceMs: graceMs,
        ...(timeoutMs === undefined ? {} : { timeoutMs })
      })
    }, graceMs)
  }

  private handleWorkerStreamEnd(requestId: string, jobId: JobId): void {
    const current = this.current
    if (
      current === null ||
      current.requestId !== requestId ||
      current.request.jobId !== jobId ||
      current.cancellationReason !== null
    ) {
      return
    }
    this.failCurrent('worker_crashed', 'Worker stream ended without a terminal response.')
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
      if (current.cancellationReason !== null) return
      const result: NestingResult = current.historySummary
        ? new NestingResultModel({
            ...parsed.payload,
            historySummary: current.historySummary
          })
        : parsed.payload
      const jobId = current.request.jobId
      clearTimeout(current.timer)
      if (current.graceTimer !== null) clearTimeout(current.graceTimer)
      this.teardownWorker(current.session)
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
      const code: AppErrorCode =
        current.cancellationReason === null
          ? parsed.error.code
          : current.cancellationReason === 'cancelled'
            ? 'worker_cancelled'
            : 'worker_timeout'
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

  private dispatchEvent(current: PendingJob, event: NestingHistoryEvent): void {
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
    if (current === null || current.requestId !== requestId || current.request.jobId !== jobId) {
      return
    }
    if (current.cancellationReason !== null) return
    this.failCurrent('worker_crashed', err instanceof Error ? err.message : String(err))
  }

  private failCurrent(
    code: AppErrorCode,
    message: string,
    context: Readonly<Record<string, unknown>> = {}
  ): void {
    if (!this.current) return
    clearTimeout(this.current.timer)
    if (this.current.graceTimer !== null) clearTimeout(this.current.graceTimer)
    const err = new SupervisorError(code, message, {
      jobId: this.current.request.jobId,
      ...context
    })
    this.teardownWorker(this.current.session)
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
