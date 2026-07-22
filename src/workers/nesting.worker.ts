import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import { computeNesting } from './algorithm/computeNesting.js'
import {
  computeIrregularNesting,
  type IrregularComputeErrorType,
  type IrregularStateSnapshot
} from './algorithm/irregular/computeIrregularNesting.js'
import {
  irregularStrategyRunId,
  makeIrregularHistoryFrame,
  makeIrregularWorkerOutput
} from './algorithm/irregular/irregularWorkerOutput.js'
import { IrregularLayoutScorer } from './algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from './algorithm/irregular/irregularPlacementScorer.js'
import type { IrregularDecisionTraceEvent } from './algorithm/irregular/decisionTrace.js'
import {
  IrregularDecisionTraceBatcher,
  serializeIrregularDecisionTraceBatch
} from './decisionTraceNdjson.js'
import { IRREGULAR_WORKER_MODE } from '@shared/irregular/defaults.js'
import { CollisionGeometryBuilder } from './irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from './irregular/geometryKernel.js'
import { FreeMaterialServiceLive } from './irregular/freeMaterialService.js'
import { NfpIfpServiceLive } from './irregular/nfpIfpService.js'
import { TransformGeneratorLive } from './irregular/transformGenerator.js'
import {
  NestingWorkerRpcs,
  WorkerFailureResponse,
  WorkerResponseFailureError,
  WorkerHistoryCompleteResponse,
  WorkerHistoryFrameResponse,
  WorkerProgressResponse,
  WorkerSuccessResponse,
  type RunNestingPayload,
  type WorkerProgress,
  type WorkerResponse
} from '@shared/protocol/worker.js'
import type {
  NestingHistoryFramePayload,
  NestingHistorySummary,
  NestingRequest,
  NestingResult
} from '@shared/domain/nesting.js'
import type { IrregularPortfolioProgress } from '@shared/irregular/domain.js'
import { Cause, Effect, Fiber, FileSystem, Layer, Path, PlatformError, Queue, Stream } from 'effect'
import * as RpcServer from 'effect/unstable/rpc/RpcServer'

/**
 * Nesting worker thread. Receives schema-validated RPC requests, runs the
 * computation, and streams progress + history + success/failure events back to
 * the supervisor.
 *
 * History persistence: the worker writes each emitted frame to a per-job NDJSON
 * file under the main-provided durable history directory. The path is returned
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
 * Where history files live. Main owns the durable file layout and passes this
 * via the worker environment. The bundle-adjacent fallback is only for direct
 * worker execution outside Electron.
 */
const HISTORY_DIR_ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.['MIN_PLANE_HISTORY_DIR']

function prepareHistoryFile(
  jobId: string,
  historyMode: NestingRequest['options']['historyMode'],
  mode: 'append' | 'truncate'
) {
  return Effect.gen(function* () {
    if (historyMode === 'off') return null
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const historyDir =
      HISTORY_DIR_ENV ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'history')
    const historyPath = path.join(historyDir, `${jobId}.ndjson`)
    yield* fs.makeDirectory(path.dirname(historyPath), { recursive: true })
    yield* fs.writeFileString(historyPath, '', { flag: mode === 'append' ? 'a' : 'w' })
    return historyPath
  })
}

function appendFrame(path: string, frame: NestingHistoryFramePayload) {
  return Effect.gen(function* () {
    const filePath = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(filePath.dirname(path), { recursive: true })
    yield* fs.writeFileString(path, `${JSON.stringify(frame)}\n`, { flag: 'a' })
  })
}

function prepareDecisionTraceFile(
  jobId: string,
  historyPath: string | null,
  mode: 'append' | 'truncate'
) {
  return Effect.gen(function* () {
    if (historyPath === null) return null
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const decisionTracePath = path.join(
      path.dirname(historyPath),
      `${jobId}.decision-trace.ndjson`
    )
    yield* fs.writeFileString(decisionTracePath, '', { flag: mode === 'append' ? 'a' : 'w' })
    return decisionTracePath
  })
}

function appendDecisionTraceBatch(
  path: string,
  events: ReadonlyArray<IrregularDecisionTraceEvent>
) {
  return Effect.gen(function* () {
    const filePath = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(filePath.dirname(path), { recursive: true })
    yield* fs.writeFileString(path, serializeIrregularDecisionTraceBatch(events), { flag: 'a' })
  })
}

function makeDecisionTraceEmitter(
  decisionTracePath: string | null,
  incrementEventCount: (count: number) => void
): (
  events: ReadonlyArray<IrregularDecisionTraceEvent>
) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  if (decisionTracePath === null) return (_events) => Effect.void
  return (events) =>
    Effect.gen(function* () {
      incrementEventCount(events.length)
      yield* appendDecisionTraceBatch(decisionTracePath, events)
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
  frame: NestingHistoryFramePayload
) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  if (historyMode === 'off') {
    return (_frame: NestingHistoryFramePayload) => Effect.void
  }
  return (frame: NestingHistoryFramePayload) =>
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
    yield* sendProgress(send, requestId, jobId, 'received')
    yield* sendProgress(send, requestId, jobId, 'validated')
    yield* sendProgress(send, requestId, jobId, 'started')

    const historyMode = payload.options.historyMode
    const historyFileMode = payload.strategyRunId !== undefined ? 'append' : 'truncate'
    const historyPath = yield* prepareHistoryFile(jobId, historyMode, historyFileMode)
    const decisionTracePath =
      payload.options.workerMode === IRREGULAR_WORKER_MODE
        ? yield* prepareDecisionTraceFile(jobId, historyPath, historyFileMode)
        : null

    let frameCount = 0
    let decisionTraceEventCount = 0
    const frameQueue = yield* Queue.unbounded<NestingHistoryFramePayload, Cause.Done>()
    const decisionTraceQueue = yield* Queue.unbounded<
      ReadonlyArray<IrregularDecisionTraceEvent>,
      Cause.Done
    >()
    const emitFrame = makeFrameEmitter(send, requestId, jobId, historyMode, historyPath, () => {
      frameCount++
    })
    const frameConsumer = yield* Stream.fromQueue(frameQueue).pipe(
      Stream.runForEach(emitFrame),
      Effect.forkDetach
    )
    const emitDecisionTrace = makeDecisionTraceEmitter(decisionTracePath, (count) => {
      decisionTraceEventCount += count
    })
    const decisionTraceConsumer = yield* Stream.fromQueue(decisionTraceQueue).pipe(
      Stream.runForEach(emitDecisionTrace),
      Effect.forkDetach
    )
    const decisionTraceBatcher =
      decisionTracePath === null
        ? undefined
        : new IrregularDecisionTraceBatcher({
            emitBatch: (events) => {
              Queue.offerUnsafe(decisionTraceQueue, events)
            }
          })
    const computation: Effect.Effect<NestingResult, WorkerResponseFailureError> =
      payload.options.workerMode === IRREGULAR_WORKER_MODE
        ? computeIrregularWorkerResult(
            payload,
            historyMode === 'off'
              ? undefined
              : (frame) => {
                  Queue.offerUnsafe(frameQueue, frame)
                },
            (progress) =>
              send(
                WorkerProgressResponse.forPortfolioProgress({
                  requestId,
                  jobId,
                  progress
                })
              ),
            decisionTracePath === null
              ? undefined
              : (event) => {
                  decisionTraceBatcher?.add(event)
                }
          )
        : Effect.sync(() =>
            computeNesting(payload, {
              emitFrame: (frame) => {
                Queue.offerUnsafe(frameQueue, frame)
              }
            })
          )
    const completion = yield* computation.pipe(
      Effect.match({
        onFailure: (error) => ({ type: 'failure' as const, error }),
        onSuccess: (result) => ({ type: 'success' as const, result })
      }),
      Effect.ensuring(
        Effect.sync(() => decisionTraceBatcher?.flush()).pipe(
          Effect.flatMap(() => Queue.end(frameQueue)),
          Effect.flatMap(() => Queue.end(decisionTraceQueue))
        )
      )
    )
    yield* Fiber.join(frameConsumer)
    yield* Fiber.join(decisionTraceConsumer)

    if (completion.type === 'failure') {
      yield* send(
        new WorkerFailureResponse({
          requestId,
          jobId,
          error: completion.error
        })
      )
      return
    }

    const result = completion.result

    const strategyRunIds = result.strategyResults.map((s) => s.strategyRunId)

    const summary: NestingHistorySummary = {
      frameCount,
      strategyRunCount: result.strategyResults.length,
      retainedFrameCount: historyMode === 'off' ? 0 : frameCount,
      truncated: false,
      scope: 'winning_path',
      strategyRunIds,
      ...(historyPath ? { ndjsonPath: historyPath } : {}),
      ...(decisionTracePath
        ? { decisionTracePath, decisionTraceEventCount }
        : {})
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

function computeIrregularWorkerResult(
  request: NestingRequest,
  emitFrame?: (frame: NestingHistoryFramePayload) => void,
  emitPortfolioProgress?: (progress: IrregularPortfolioProgress) => Effect.Effect<void>,
  emitDecisionTrace?: (event: IrregularDecisionTraceEvent) => void
): Effect.Effect<NestingResult, WorkerResponseFailureError> {
  const startedAt = new Date().toISOString()
  const startedAtMs = Date.now()
  const strategyRunId = irregularStrategyRunId(request)

  const options =
    emitFrame === undefined &&
    emitPortfolioProgress === undefined &&
    emitDecisionTrace === undefined
      ? undefined
      : {
          ...(emitFrame !== undefined
            ? {
                emitStateSnapshot: (snapshot: IrregularStateSnapshot, beamWidth: number) => {
                  emitFrame(
                    makeIrregularHistoryFrame({
                      request,
                      strategyRunId,
                      snapshot,
                      beamWidth,
                      createdAt: new Date().toISOString()
                    })
                  )
                }
              }
            : {}),
          ...(emitPortfolioProgress !== undefined ? { emitPortfolioProgress } : {}),
          ...(emitDecisionTrace !== undefined ? { emitDecisionTrace } : {})
        }
  const geometrySettings = request.options.irregularSettings ?? GeometrySettings.Make

  return computeIrregularNesting(request, options).pipe(
    Effect.map((computed) => {
      const endedAt = new Date().toISOString()
      const output = makeIrregularWorkerOutput({
        request,
        computed,
        algorithmBenchmark: {
          startedAt,
          endedAt,
          elapsedMs: Math.max(0, Date.now() - startedAtMs)
        }
      })
      return output.result
    }),
    Effect.provide(CollisionGeometryBuilder.Live),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(NfpIfpServiceLive),
    Effect.provide(FreeMaterialServiceLive),
    Effect.provide(IrregularPlacementScorer.Layer),
    Effect.provide(IrregularLayoutScorer.Live),
    Effect.provide(GeometryKernel.Live),
    Effect.provide(Layer.succeed(GeometrySettings, geometrySettings)),
    Effect.mapError(toIrregularWorkerFailure)
  )
}

function toIrregularWorkerFailure(error: IrregularComputeErrorType): WorkerResponseFailureError {
  switch (error._tag) {
    case 'IrregularComputeError':
      return new WorkerResponseFailureError({
        code: 'irregular_source_geometry_missing',
        message: error.message,
        context: {
          preparedPieceId: error.preparedPieceId,
          sourcePieceId: error.sourcePieceId
        }
      })
    case 'IrregularGeometryInputError':
      return new WorkerResponseFailureError({
        code: 'irregular_geometry_invalid',
        message: error.message,
        context: { operation: error.operation }
      })
    case 'IrregularNestingNotImplementedError':
      return new WorkerResponseFailureError({
        code: 'not_implemented',
        message: error.message,
        context: { service: error.service, operation: error.operation }
      })
    case 'IrregularPlacementScoringError':
    case 'IrregularLayoutScoringError':
      return new WorkerResponseFailureError({
        code: 'irregular_scoring_error',
        message: error.message,
        context: { operation: error.operation }
      })
    case 'IrregularPortfolioError':
      return new WorkerResponseFailureError({
        code:
          error.category === 'geometry' ? 'irregular_geometry_invalid' : 'irregular_scoring_error',
        message: error.message,
        context: { operation: error.operation, category: error.category }
      })
    case 'IrregularNfpIfpControlAbortError':
      return new WorkerResponseFailureError({
        code: error.reason === 'cancelled' ? 'worker_cancelled' : 'worker_timeout',
        message: error.message,
        context: { reason: error.reason }
      })
  }
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
