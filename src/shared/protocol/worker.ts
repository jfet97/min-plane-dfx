import { Effect, Schema } from 'effect'
import * as Rpc from 'effect/unstable/rpc/Rpc'
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import { JobId } from '../domain/ids.js'
import {
  NestingRequest,
  NestingResult,
  NestingHistoryFramePayload,
  NestingHistorySummary
} from '../domain/nesting.js'
import { IrregularPortfolioProgress } from '../irregular/domain.js'
import { AppErrorCode, type SerializedAppError } from './errors.js'

/** Worker progress phases. Honest, lifecycle-only: no fake algorithm %. */
export const WorkerProgressPhase = [
  'received',
  'validated',
  'started',
  'completed',
  'cancelled'
] as const
export type WorkerProgressPhase = (typeof WorkerProgressPhase)[number]

export class WorkerProgress extends Schema.Class<WorkerProgress>('WorkerProgress')({
  phase: Schema.Literals([...WorkerProgressPhase]),
  at: Schema.String,
  portfolio: Schema.optional(IrregularPortfolioProgress)
}) {}

export class RunNestingWorkerRequest extends Schema.Class<RunNestingWorkerRequest>(
  'RunNestingWorkerRequest'
)({
  type: Schema.Literal('run_nesting').pipe(
    Schema.withConstructorDefault(Effect.succeed('run_nesting' as const))
  ),
  requestId: Schema.String,
  payload: NestingRequest
}) {}

export class CancelWorkerRequest extends Schema.Class<CancelWorkerRequest>('CancelWorkerRequest')({
  type: Schema.Literal('cancel').pipe(
    Schema.withConstructorDefault(Effect.succeed('cancel' as const))
  ),
  requestId: Schema.String,
  jobId: JobId
}) {}

export const WorkerRequest = Schema.Union([RunNestingWorkerRequest, CancelWorkerRequest])
export type WorkerRequest = Schema.Schema.Type<typeof WorkerRequest>

export class WorkerResponseFailureError extends Schema.Class<WorkerResponseFailureError>(
  'WorkerResponseFailureError'
)({
  code: Schema.Literals([...AppErrorCode]),
  message: Schema.String,
  context: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
}) {}

export class WorkerProgressResponse extends Schema.Class<WorkerProgressResponse>(
  'WorkerProgressResponse'
)({
  type: Schema.Literal('progress').pipe(
    Schema.withConstructorDefault(Effect.succeed('progress' as const))
  ),
  requestId: Schema.String,
  jobId: JobId,
  payload: WorkerProgress
}) {
  static forPhase(input: {
    readonly requestId: string
    readonly jobId: JobId
    readonly phase: WorkerProgress['phase']
    readonly at?: string
  }): WorkerProgressResponse {
    return new WorkerProgressResponse({
      requestId: input.requestId,
      jobId: input.jobId,
      payload: new WorkerProgress({
        phase: input.phase,
        at: input.at ?? new Date().toISOString()
      })
    })
  }

  static forPortfolioProgress(input: {
    readonly requestId: string
    readonly jobId: JobId
    readonly progress: IrregularPortfolioProgress
    readonly at?: string
  }): WorkerProgressResponse {
    return new WorkerProgressResponse({
      requestId: input.requestId,
      jobId: input.jobId,
      payload: new WorkerProgress({
        phase: 'started',
        at: input.at ?? new Date().toISOString(),
        portfolio: input.progress
      })
    })
  }
}

export class WorkerHistoryFrameResponse extends Schema.Class<WorkerHistoryFrameResponse>(
  'WorkerHistoryFrameResponse'
)({
  type: Schema.Literal('history_frame').pipe(
    Schema.withConstructorDefault(Effect.succeed('history_frame' as const))
  ),
  requestId: Schema.String,
  jobId: JobId,
  payload: NestingHistoryFramePayload
}) {}

export class WorkerHistoryCompleteResponse extends Schema.Class<WorkerHistoryCompleteResponse>(
  'WorkerHistoryCompleteResponse'
)({
  type: Schema.Literal('history_complete').pipe(
    Schema.withConstructorDefault(Effect.succeed('history_complete' as const))
  ),
  requestId: Schema.String,
  jobId: JobId,
  payload: NestingHistorySummary
}) {}

export class WorkerSuccessResponse extends Schema.Class<WorkerSuccessResponse>(
  'WorkerSuccessResponse'
)({
  type: Schema.Literal('success').pipe(
    Schema.withConstructorDefault(Effect.succeed('success' as const))
  ),
  requestId: Schema.String,
  jobId: JobId,
  payload: NestingResult
}) {}

export class WorkerFailureResponse extends Schema.Class<WorkerFailureResponse>(
  'WorkerFailureResponse'
)({
  type: Schema.Literal('failure').pipe(
    Schema.withConstructorDefault(Effect.succeed('failure' as const))
  ),
  requestId: Schema.String,
  jobId: Schema.optional(JobId),
  error: WorkerResponseFailureError
}) {
  static unknown(input: {
    readonly requestId: string
    readonly jobId?: JobId
    readonly message: string
  }): WorkerFailureResponse {
    return new WorkerFailureResponse({
      requestId: input.requestId,
      ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
      error: new WorkerResponseFailureError({
        code: 'unknown_error',
        message: input.message
      })
    })
  }
}

export const WorkerResponse = Schema.Union([
  WorkerProgressResponse,
  WorkerHistoryFrameResponse,
  WorkerHistoryCompleteResponse,
  WorkerSuccessResponse,
  WorkerFailureResponse
])
export type WorkerResponse = Schema.Schema.Type<typeof WorkerResponse>

export class RunNestingPayload extends Schema.Class<RunNestingPayload>('RunNestingPayload')({
  requestId: Schema.String,
  request: NestingRequest
}) {}

export const NestingWorkerRpcs = RpcGroup.make(
  Rpc.make('RunNesting', {
    payload: RunNestingPayload,
    success: WorkerResponse,
    stream: true
  })
)

/** Allow consumers to type-guard a thrown error. */
export type WorkerFailure = Extract<Schema.Schema.Type<typeof WorkerResponse>, { type: 'failure' }>

export type WorkerResponseSerializedAppError = SerializedAppError
