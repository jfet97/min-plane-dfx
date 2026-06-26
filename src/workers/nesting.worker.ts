import { parentPort } from 'node:worker_threads'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { computeNestingStub } from './algorithm/computeNestingStub.js'
import {
  WorkerRequest as WorkerRequestSchema,
  type WorkerProgress,
  type WorkerRequest,
  type WorkerResponse
} from '@shared/protocol/worker.js'
import type {
  NestingHistoryFrame,
  NestingHistorySummary,
  NestingRequest
} from '@shared/domain/nesting.js'
import { Exit, Schema } from 'effect'

/**
 * Nesting worker thread. Receives a validated WorkerRequest, runs the
 * computation, and emits progress + history + success/failure events back to
 * the supervisor via postMessage.
 *
 * For now this only invokes the algorithm stub. The user-written algorithm
 * replaces the body of `computeNestingStub` without changing this file.
 *
 * History persistence: the worker writes each frame it would emit to a
 * per-job NDJSON file under `<projectRoot>/out/history/<jobId>.ndjson`.
 * The path is returned inside the `history_complete` event so the renderer
 * can hand it to the user via Export History.
 */
const port = parentPort
if (!port) {
  throw new Error('nesting.worker.ts must be loaded as a worker_threads module')
}

function send(response: WorkerResponse): void {
  port!.postMessage(response)
}

function sendProgress(
  requestId: string,
  jobId: NestingRequest['jobId'],
  phase: WorkerProgress['phase']
): void {
  send({
    type: 'progress',
    requestId,
    jobId,
    payload: { phase, at: new Date().toISOString() }
  })
}

/**
 * Where history files live. The supervisor overrides this through the
 * WorkerRequest payload options when it owns the file layout. For the
 * first version we resolve it next to the worker bundle so production
 * builds land somewhere predictable.
 */
const HISTORY_DIR_ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.['MIN_PLANE_HISTORY_DIR']

function resolveHistoryDir(): string {
  if (HISTORY_DIR_ENV) return HISTORY_DIR_ENV
  // Fallback: alongside the worker bundle under `out/main/history`.
  return join(dirname(new URL(import.meta.url).pathname), 'history')
}

function historyPathFor(jobId: string): string {
  return join(resolveHistoryDir(), `${jobId}.ndjson`)
}

async function appendFrame(path: string, frame: NestingHistoryFrame): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(frame)}\n`, { flag: 'a', encoding: 'utf8' })
}

function buildInitialFrame(request: NestingRequest, runId: string): NestingHistoryFrame {
  return {
    frameId: randomUUID(),
    jobId: request.jobId,
    strategyRunId: runId,
    strategyLabel: 'stub',
    stepIndex: 0,
    beamRank: 0,
    title: 'stub-initial',
    plate: { placements: [], freeRectangles: [] },
    createdAt: new Date().toISOString()
  }
}

async function handleRunNesting(requestId: string, payload: NestingRequest): Promise<void> {
  const jobId = payload.jobId
  const startedAt = Date.now()

  sendProgress(requestId, jobId, 'received')
  sendProgress(requestId, jobId, 'validated')
  sendProgress(requestId, jobId, 'started')

  const historyPath = historyPathFor(jobId)
  // Truncate any previous file for the same job id so replay is clean.
  await mkdir(dirname(historyPath), { recursive: true })
  await writeFile(historyPath, '', { flag: 'w', encoding: 'utf8' })

  try {
    const result = computeNestingStub(payload, Date.now() - startedAt)
    const strategyRunIds = result.strategyResults.map((s) => s.strategyRunId)

    // Emit one stub history frame per strategy run so the NDJSON replay is
    // observable end-to-end. No fake placements, no fake free rectangles,
    // no fake beam data — only the lifecycle marker required to prove the
    // streaming path.
    let frameCount = 0
    const retainedFrames: NestingHistoryFrame[] = []
    for (const strategy of result.strategyResults) {
      const frame = buildInitialFrame(payload, strategy.strategyRunId)
      retainedFrames.push(frame)
      await appendFrame(historyPath, frame)
      send({
        type: 'history_frame',
        requestId,
        jobId,
        payload: frame
      })
      frameCount++
    }

    const summary: NestingHistorySummary = {
      frameCount,
      strategyRunCount: result.strategyResults.length,
      retainedFrameCount: frameCount,
      truncated: false,
      scope: 'winning_path',
      strategyRunIds,
      ndjsonPath: historyPath
    }
    send({
      type: 'history_complete',
      requestId,
      jobId,
      payload: summary
    })

    sendProgress(requestId, jobId, 'completed')
    send({
      type: 'success',
      requestId,
      jobId,
      payload: result
    })
  } catch (err) {
    send({
      type: 'failure',
      requestId,
      jobId,
      error: {
        code: 'unknown_error',
        message: err instanceof Error ? err.message : 'unknown error'
      }
    })
  }
}

port.on('message', (raw: unknown) => {
  // Validate the incoming message at the boundary. Anything malformed is
  // rejected with a failure response that does not require a jobId, since we
  // cannot trust the sender.
  const exit = Schema.decodeUnknownExit(WorkerRequestSchema)(raw)
  if (Exit.isFailure(exit)) {
    send({
      type: 'failure',
      requestId: 'unknown',
      error: {
        code: 'worker_protocol_error',
        message: 'Worker received an invalid request'
      }
    })
    return
  }
  const request: WorkerRequest = exit.value
  if (request.type === 'run_nesting') {
    void handleRunNesting(request.requestId, request.payload)
  } else if (request.type === 'cancel') {
    send({
      type: 'failure',
      requestId: request.requestId,
      jobId: request.jobId,
      error: {
        code: 'worker_cancelled',
        message: 'Job cancelled by renderer request'
      }
    })
  }
})