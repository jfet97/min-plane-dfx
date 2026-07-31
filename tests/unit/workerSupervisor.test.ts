import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { NestingRequest, NestingResult } from '@shared/domain/nesting.js'
import {
  CancelNestingAcknowledgement,
  WorkerFailureResponse,
  WorkerResponse,
  WorkerResponseFailureError,
  WorkerSuccessResponse,
  type CancelNestingPayload
} from '@shared/protocol/worker.js'
import {
  WORKER_RPC_POOL_OPTIONS,
  WorkerSupervisor,
  type WorkerSupervisorSession,
  type WorkerSupervisorSessionFactoryInput
} from '../../src/main/services/WorkerSupervisor.js'

function request(timeoutMs = 5_000): NestingRequest {
  return Schema.decodeUnknownSync(NestingRequest)({
    version: 1,
    jobId: 'job-1',
    sheet: { width: 100, height: 100, label: 'default' },
    padding: 2,
    pieces: [
      {
        id: 'p-1',
        sourcePieceId: 'p-1',
        realBounds: { x: 0, y: 0, width: 10, height: 5 },
        paddedBounds: {
          x: 0,
          y: 0,
          width: 14,
          height: 9,
          longestEdge: 14,
          area: 126,
          imbalance: 5
        },
        padding: 2,
        allowRotation: true
      }
    ],
    options: {
      allowGlobalRotation: true,
      timeoutMs,
      workerMode: 'maxrects-beam-search',
      historyMode: 'stream',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: ['balanced-preserve-free-then-bottom-left'],
      layoutSelectionStrategyId: 'compact-first',
      finalSelectionMode: 'manual'
    }
  })
}

class FakeWorkerSession implements WorkerSupervisorSession {
  readonly controls: CancelNestingPayload[] = []
  disposeCount = 0
  private onMessage: ((message: WorkerResponse) => void) | undefined
  private resolveRun: (() => void) | undefined

  start(input: WorkerSupervisorSessionFactoryInput): Promise<void> {
    this.onMessage = input.onMessage
    return new Promise<void>((resolve) => {
      this.resolveRun = resolve
    })
  }

  async cancel(payload: CancelNestingPayload): Promise<CancelNestingAcknowledgement> {
    this.controls.push(payload)
    return new CancelNestingAcknowledgement({
      requestId: payload.requestId,
      jobId: payload.jobId,
      accepted: true,
      activeReason: payload.reason
    })
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1
  }

  emit(message: WorkerResponse, end = false): void {
    this.onMessage?.(message)
    if (end) this.resolveRun?.()
  }
}

function makeSupervisor(session: FakeWorkerSession, cancellationGraceMs = 100): WorkerSupervisor {
  return new WorkerSupervisor({
    workerPath: '/unused/worker.mjs',
    historyDirectory: '/tmp',
    defaultTimeoutMs: 5_000,
    cancellationGraceMs,
    sessionFactory: () => session
  })
}

function historyFrame(requestId: string): WorkerResponse {
  return Schema.decodeUnknownSync(WorkerResponse)({
    type: 'history_frame',
    requestId,
    jobId: request().jobId,
    payload: {
      frameId: 'frame-1',
      jobId: request().jobId,
      strategyRunId: 'run-1',
      strategyLabel: 'test',
      stepIndex: 0,
      beamRank: 0,
      title: 'queued frame',
      plate: { placements: [], freeRectangles: [] },
      state: { remainingPieceIds: [], unplacedPieceIds: [] },
      createdAt: '2026-07-30T00:00:00.000Z'
    }
  })
}

function cancellationFailure(
  requestId: string,
  code: 'worker_cancelled' | 'worker_timeout'
): WorkerFailureResponse {
  const reason = code === 'worker_cancelled' ? 'cancelled' : 'timeout'
  return new WorkerFailureResponse({
    requestId,
    jobId: request().jobId,
    error: new WorkerResponseFailureError({
      code,
      message: reason,
      context: { reason }
    })
  })
}

describe('WorkerSupervisor cancellation control', () => {
  it('reserves a second request permit for cancellation while the stream is active', () => {
    expect(WORKER_RPC_POOL_OPTIONS).toEqual({ size: 1, concurrency: 2 })
  })

  it('sends user cancellation, drains queued events, and waits for typed terminal failure', async () => {
    const session = new FakeWorkerSession()
    const supervisor = makeSupervisor(session)
    const events: WorkerResponse[] = []
    let settled = false
    const completion = supervisor
      .runNesting(request(), (event) => events.push(event))
      .finally(() => {
        settled = true
      })

    supervisor.cancelJob(request().jobId)
    await Promise.resolve()

    expect(session.controls).toHaveLength(1)
    expect(session.controls[0]).toMatchObject({ reason: 'cancelled', jobId: 'job-1' })
    expect(settled).toBe(false)
    expect(session.disposeCount).toBe(0)

    const requestId = session.controls[0]?.requestId ?? ''
    session.emit(historyFrame(requestId))
    session.emit(cancellationFailure(requestId, 'worker_cancelled'), true)

    await expect(completion).rejects.toMatchObject({ code: 'worker_cancelled' })
    expect(events.some((event) => event.type === 'history_frame')).toBe(true)
    expect(session.disposeCount).toBe(1)
  })

  it('sends timeout control and waits for worker_timeout terminal failure', async () => {
    const session = new FakeWorkerSession()
    const supervisor = makeSupervisor(session)
    const completion = supervisor.runNesting(request(10), () => undefined)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(session.controls).toHaveLength(1)
    expect(session.controls[0]).toMatchObject({ reason: 'timeout' })
    expect(session.disposeCount).toBe(0)

    const requestId = session.controls[0]?.requestId ?? ''
    session.emit(cancellationFailure(requestId, 'worker_timeout'), true)

    await expect(completion).rejects.toMatchObject({ code: 'worker_timeout' })
    expect(session.disposeCount).toBe(1)
  })

  it('suppresses success after cancellation and disposes only when grace expires', async () => {
    const session = new FakeWorkerSession()
    const supervisor = makeSupervisor(session, 20)
    let resultBroadcasts = 0
    supervisor.onResult(() => {
      resultBroadcasts += 1
    })
    const completion = supervisor.runNesting(request(), () => undefined)

    supervisor.cancelJob(request().jobId)
    await Promise.resolve()
    const requestId = session.controls[0]?.requestId ?? ''
    session.emit(
      new WorkerSuccessResponse({
        requestId,
        jobId: request().jobId,
        payload: NestingResult.fromAlgorithm({
          request: request(),
          strategyResults: [],
          sortedPieceIds: [],
          placements: [],
          unplacedPieceIds: [],
          elapsedMs: 0,
          algorithmBenchmark: {
            startedAt: '2026-07-30T00:00:00.000Z',
            endedAt: '2026-07-30T00:00:00.000Z',
            elapsedMs: 0
          }
        })
      }),
      true
    )

    await expect(completion).rejects.toMatchObject({ code: 'worker_cancelled' })
    expect(resultBroadcasts).toBe(0)
    expect(session.disposeCount).toBe(1)
  })
})
