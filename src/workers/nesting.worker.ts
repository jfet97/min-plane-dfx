import { parentPort } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { NodeFileSystem, NodePath } from '@effect/platform-node'
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
import { Effect, Exit, FileSystem, Layer, ManagedRuntime, Path, Schema } from 'effect'

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
const workerPort = port

function send(response: WorkerResponse): void {
  workerPort.postMessage(response)
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

const WorkerLiveLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
const workerRuntime = ManagedRuntime.make(WorkerLiveLayer)

function prepareHistoryFile(jobId: string, historyMode: NestingRequest['options']['historyMode']) {
  return Effect.gen(function* () {
    if (historyMode === 'off') return null
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const historyDir =
      HISTORY_DIR_ENV ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'history')
    const historyPath = path.join(historyDir, `${jobId}.ndjson`)
    yield* fs.makeDirectory(path.dirname(historyPath), { recursive: true })
    yield* fs.writeFileString(historyPath, '', { flag: 'w' })
    return historyPath
  })
}

function appendFrame(path: string, frame: NestingHistoryFrame) {
  return Effect.gen(function* () {
    const filePath = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(filePath.dirname(path), { recursive: true })
    yield* fs.writeFileString(path, `${JSON.stringify(frame)}\n`, { flag: 'a' })
  })
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

  // History file setup must be inside the try block: if mkdir or the
  // truncating writeFile throws before the algorithm runs, the supervisor
  // would otherwise wait the full timeout before giving up. Round 2 (F3).
  try {
    sendProgress(requestId, jobId, 'received')
    sendProgress(requestId, jobId, 'validated')
    sendProgress(requestId, jobId, 'started')

    const historyMode = payload.options.historyMode
    const historyPath = await workerRuntime.runPromise(prepareHistoryFile(jobId, historyMode))
    const result = computeNestingStub(payload, Date.now() - startedAt)
    const strategyRunIds = result.strategyResults.map((s) => s.strategyRunId)

    let frameCount = 0
    for (const strategy of result.strategyResults) {
      if (historyMode === 'off') continue
      const frame = buildInitialFrame(payload, strategy.strategyRunId)
      frameCount++
      // Streaming + final both persist to NDJSON. Only stream mode emits
      // history_frame events live; final mode delivers them through the
      // NDJSON replay instead.
      if (historyPath) {
        await workerRuntime.runPromise(appendFrame(historyPath, frame))
      }
      if (historyMode === 'stream') {
        send({
          type: 'history_frame',
          requestId,
          jobId,
          payload: frame
        })
      }
    }

    const summary: NestingHistorySummary = {
      frameCount,
      strategyRunCount: result.strategyResults.length,
      retainedFrameCount: historyMode === 'off' ? 0 : frameCount,
      truncated: false,
      scope: 'winning_path',
      strategyRunIds,
      ...(historyPath ? { ndjsonPath: historyPath } : {})
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
