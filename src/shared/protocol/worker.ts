import { Schema } from 'effect'
import * as Rpc from 'effect/unstable/rpc/Rpc'
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import { JobId } from '../domain/ids.js'
import { NestingRequest, NestingResult, NestingHistoryFrame } from '../domain/nesting.js'
import type { SerializedAppError } from './errors.js'

/** Worker progress phases. Honest, lifecycle-only: no fake algorithm %. */
export const WorkerProgressPhase = [
  'received',
  'validated',
  'started',
  'completed',
  'cancelled'
] as const
export type WorkerProgressPhase = (typeof WorkerProgressPhase)[number]

export const WorkerProgress = Schema.Struct({
  phase: Schema.Literals([...WorkerProgressPhase]),
  at: Schema.String
})
export type WorkerProgress = Schema.Schema.Type<typeof WorkerProgress>

export const WorkerRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('run_nesting'),
    requestId: Schema.String,
    payload: NestingRequest
  }),
  Schema.Struct({
    type: Schema.Literal('cancel'),
    requestId: Schema.String,
    jobId: JobId
  })
])
export type WorkerRequest = Schema.Schema.Type<typeof WorkerRequest>

export const NestingHistorySummary = Schema.Struct({
  frameCount: Schema.Number,
  strategyRunCount: Schema.Number,
  retainedFrameCount: Schema.Number,
  truncated: Schema.Boolean,
  scope: Schema.Literal('winning_path'),
  strategyRunIds: Schema.Array(Schema.String),
  ndjsonPath: Schema.optional(Schema.String)
})

export const WorkerResponse = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('progress'),
    requestId: Schema.String,
    jobId: JobId,
    payload: WorkerProgress
  }),
  Schema.Struct({
    type: Schema.Literal('history_frame'),
    requestId: Schema.String,
    jobId: JobId,
    payload: NestingHistoryFrame
  }),
  Schema.Struct({
    type: Schema.Literal('history_complete'),
    requestId: Schema.String,
    jobId: JobId,
    payload: NestingHistorySummary
  }),
  Schema.Struct({
    type: Schema.Literal('success'),
    requestId: Schema.String,
    jobId: JobId,
    payload: NestingResult
  }),
  Schema.Struct({
    type: Schema.Literal('failure'),
    requestId: Schema.String,
    jobId: Schema.optional(JobId),
    error: Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      context: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
    })
  })
])
export type WorkerResponse = Schema.Schema.Type<typeof WorkerResponse>

export const RunNestingPayload = Schema.Struct({
  requestId: Schema.String,
  request: NestingRequest
})
export type RunNestingPayload = Schema.Schema.Type<typeof RunNestingPayload>

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
