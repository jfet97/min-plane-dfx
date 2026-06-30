import { Schema } from 'effect'
import { NestingRequest, NestingResult } from '../domain/nesting.js'
import { WorkerRequest, WorkerResponse } from '../protocol/worker.js'
import {
  NonNegativeCoordinate,
  PositiveWidth,
  PositiveHeight,
  NonNegativePadding
} from './geometrySchemas.js'

export const NestingOptionsStrictSchema = Schema.Struct({
  allowGlobalRotation: Schema.Boolean,
  timeoutMs: Schema.Number.check(Schema.isGreaterThan(0)),
  workerMode: Schema.Literal('maxrects-beam-search'),
  historyMode: Schema.Literals(['stream', 'final', 'off']),
  historyScope: Schema.Literal('winning_path'),
  strategySelectionMode: Schema.Literals(['single', 'all_configured']),
  strategyIds: Schema.Array(Schema.String).check(Schema.isNonEmpty()),
  layoutSelectionStrategyId: Schema.String.check(Schema.isMinLength(1)),
  finalSelectionMode: Schema.Literals(['manual', 'best', 'top_n']),
  topN: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  maxHistoryEvents: Schema.optional(Schema.Number)
})

export const NestingRequestStrict = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Schema.String.check(Schema.isMinLength(1)),
  sheet: Schema.Struct({
    width: PositiveWidth,
    height: PositiveHeight,
    label: Schema.String
  }),
  padding: NonNegativePadding,
  pieces: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1)),
      sourcePieceId: Schema.String.check(Schema.isMinLength(1)),
      realBounds: Schema.Struct({
        x: NonNegativeCoordinate,
        y: NonNegativeCoordinate,
        width: PositiveWidth,
        height: PositiveHeight
      }),
      paddedBounds: Schema.Struct({
        x: NonNegativeCoordinate,
        y: NonNegativeCoordinate,
        width: PositiveWidth,
        height: PositiveHeight
      }),
      padding: NonNegativePadding,
      allowRotation: Schema.Boolean,
      cutRowRef: Schema.optional(
        Schema.Struct({
          reference: Schema.String,
          customerName: Schema.String,
          csvRowId: Schema.String
        })
      )
    })
  ).check(Schema.isNonEmpty()),
  options: NestingOptionsStrictSchema,
  strategyRunId: Schema.optional(Schema.String.check(Schema.isMinLength(1)))
})

export const NestingResultStrict = NestingResult
export const WorkerRequestStrict = WorkerRequest
export const WorkerResponseStrict = WorkerResponse

export type { NestingRequest }
export type { NestingResult }
