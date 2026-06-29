import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import { computeNesting } from './algorithm/computeNesting.js'
import {
  NestingWorkerRpcs,
  WorkerFailureResponse,
  WorkerHistoryCompleteResponse,
  WorkerHistoryFrameResponse,
  WorkerProgressResponse,
  WorkerSuccessResponse,
  type RunNestingPayload,
  type WorkerProgress,
  type WorkerResponse
} from '@shared/protocol/worker.js'
import type {
  NestingHistoryFrame,
  NestingHistorySummary,
  NestingRequest
} from '@shared/domain/nesting.js'
import { Cause, Effect, Fiber, FileSystem, Layer, Path, PlatformError, Queue, Stream } from 'effect'
import * as RpcServer from 'effect/unstable/rpc/RpcServer'

console.info('[worker:nesting] bootstrap')

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
  return send(
    WorkerProgressResponse.forPhase({
      requestId,
      jobId,
      phase
    })
  )
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
        yield* send(
          new WorkerHistoryFrameResponse({
            requestId,
            jobId,
            payload: frame
          })
        ).pipe(
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

  return Effect.gen(function* () {
    console.info('[worker:nesting] run received', {
      requestId,
      jobId,
      pieces: payload.pieces.length,
      historyMode: payload.options.historyMode
    })
    yield* sendProgress(send, requestId, jobId, 'received')
    yield* sendProgress(send, requestId, jobId, 'validated')
    yield* sendProgress(send, requestId, jobId, 'started')

    const historyMode = payload.options.historyMode
    const historyPath = yield* prepareHistoryFile(jobId, historyMode)

    let frameCount = 0
    const frameQueue = yield* Queue.unbounded<NestingHistoryFrame, Cause.Done>()
    const emitFrame = makeFrameEmitter(send, requestId, jobId, historyMode, historyPath, () => {
      frameCount++
    })
    const frameConsumer = yield* Stream.fromQueue(frameQueue).pipe(
      Stream.runForEach(emitFrame),
      Effect.forkDetach
    )
    const result = yield* Effect.sync(() => {
      console.info('[worker:nesting] compute start', { requestId, jobId })
      const computed = computeNesting(payload, {
        emitFrame: (frame) => {
          Queue.offerUnsafe(frameQueue, frame)
        }
      })
      console.info('[worker:nesting] compute end', {
        requestId,
        jobId,
        elapsedMs: computed.stats.algorithm.elapsedMs,
        placed: computed.placements.length,
        unplaced: computed.unplacedPieceIds.length
      })
      return computed
    }).pipe(Effect.ensuring(Queue.end(frameQueue)))
    yield* Fiber.join(frameConsumer)

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
    yield* send(
      new WorkerHistoryCompleteResponse({
        requestId,
        jobId,
        payload: summary
      })
    )

    yield* sendProgress(send, requestId, jobId, 'completed')
    yield* send(
      new WorkerSuccessResponse({
        requestId,
        jobId,
        payload: result
      })
    )
  }).pipe(
    Effect.catchCause((cause) =>
      send(
        WorkerFailureResponse.unknown({
          requestId,
          jobId,
          message: Cause.pretty(cause)
        })
      )
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
  if (isNormalWorkerShutdown(err)) return
  console.error('[nesting.worker] fatal worker runner error:', err)
})

function isNormalWorkerShutdown(err: unknown): boolean {
  return err instanceof Error && err.message === 'All fibers interrupted without error'
}
