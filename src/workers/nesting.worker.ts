import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import { computeNestingStub } from './algorithm/computeNestingStub.js'
import {
  NestingWorkerRpcs,
  type RunNestingPayload,
  type WorkerProgress,
  type WorkerResponse
} from '@shared/protocol/worker.js'
import type {
  NestingHistoryFrame,
  NestingHistorySummary,
  NestingRequest
} from '@shared/domain/nesting.js'
import { Cause, Effect, FileSystem, Layer, Path, PlatformError, Queue } from 'effect'
import * as RpcServer from 'effect/unstable/rpc/RpcServer'

/**
 * Nesting worker thread. Receives schema-validated RPC requests, runs the
 * computation, and streams progress + history + success/failure events back to
 * the supervisor.
 *
 * History persistence: the worker writes each emitted frame to a per-job NDJSON
 * file under `<projectRoot>/out/history/<jobId>.ndjson`. The path is returned
 * inside the `history_complete` event so the renderer can hand it to the user
 * via Export History.
 */
type SendResponse = (response: WorkerResponse) => Effect.Effect<void>

function sendProgress(
  send: SendResponse,
  requestId: string,
  jobId: NestingRequest['jobId'],
  phase: WorkerProgress['phase']
): Effect.Effect<void> {
  return send({
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

function makeFrameEmitter(
  send: SendResponse,
  requestId: string,
  jobId: NestingRequest['jobId'],
  historyMode: NestingRequest['options']['historyMode'],
  historyPath: string | null,
  incrementFrameCount: () => void
): (
  frame: NestingHistoryFrame
) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  if (historyMode === 'off') {
    return (_frame: NestingHistoryFrame) => Effect.void
  }
  return (frame: NestingHistoryFrame) =>
    Effect.gen(function* () {
      incrementFrameCount()
      if (historyPath) {
        yield* appendFrame(historyPath, frame)
      }
      if (historyMode === 'stream') {
        yield* send({
          type: 'history_frame',
          requestId,
          jobId,
          payload: frame
        }).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.asVoid
        )
      }
    })
}

function handleRunNesting(
  send: SendResponse,
  requestId: string,
  payload: NestingRequest
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> {
  const jobId = payload.jobId
  const startedAt = Date.now()

  return Effect.gen(function* () {
    yield* sendProgress(send, requestId, jobId, 'received')
    yield* sendProgress(send, requestId, jobId, 'validated')
    yield* sendProgress(send, requestId, jobId, 'started')

    const historyMode = payload.options.historyMode
    const historyPath = yield* prepareHistoryFile(jobId, historyMode)

    let frameCount = 0
    const emitFrame = makeFrameEmitter(send, requestId, jobId, historyMode, historyPath, () => {
      frameCount++
    })
    const result = yield* computeNestingStub(payload, Date.now() - startedAt, { emitFrame })
    const strategyRunIds = result.strategyResults.map((s) => s.strategyRunId)

    const summary: NestingHistorySummary = {
      frameCount,
      strategyRunCount: result.strategyResults.length,
      retainedFrameCount: historyMode === 'off' ? 0 : frameCount,
      truncated: false,
      scope: 'winning_path',
      strategyRunIds,
      ...(historyPath ? { ndjsonPath: historyPath } : {})
    }
    yield* send({
      type: 'history_complete',
      requestId,
      jobId,
      payload: summary
    })

    yield* sendProgress(send, requestId, jobId, 'completed')
    yield* send({
      type: 'success',
      requestId,
      jobId,
      payload: result
    })
  }).pipe(
    Effect.catchCause((cause) =>
      send({
        type: 'failure',
        requestId,
        jobId,
        error: {
          code: 'unknown_error',
          message: Cause.pretty(cause)
        }
      })
    )
  )
}

const NestingWorkerHandlers = NestingWorkerRpcs.toLayer(
  Effect.succeed(
    NestingWorkerRpcs.of({
      RunNesting: (payload: RunNestingPayload) =>
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<WorkerResponse, Cause.Done>()
          const send: SendResponse = (response) =>
            Queue.offer(queue, response).pipe(
              Effect.catchCause(() => Effect.void),
              Effect.asVoid
            )
          yield* handleRunNesting(send, payload.requestId, payload.request).pipe(
            Effect.ensuring(Queue.end(queue)),
            Effect.forkScoped
          )
          return queue
        })
    })
  )
)

const WorkerServices = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const WorkerLive = RpcServer.layer(NestingWorkerRpcs, { disableFatalDefects: true }).pipe(
  Layer.provide(NestingWorkerHandlers),
  Layer.provide(WorkerServices),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer)
)

void Effect.runPromise(Layer.launch(WorkerLive)).catch((err: unknown) => {
  console.error('[nesting.worker] fatal worker runner error:', err)
})
