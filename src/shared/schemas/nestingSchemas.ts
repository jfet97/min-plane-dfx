import { Effect, Schema } from 'effect'
import { ImportedPiece } from '../domain/dxf.js'
import { RectWith } from '../domain/geometry.js'
import { NestingRequest, NestingResult } from '../domain/nesting.js'
import { WorkerRequest, WorkerResponse } from '../protocol/worker.js'
import { IrregularNestingSettings } from '../irregular/domain.js'
import {
  NonNegativeCoordinate,
  PositiveWidth,
  PositiveHeight,
  NonNegativePadding
} from './geometrySchemas.js'

const NestingOptionsStrictFields = Schema.Struct({
  allowGlobalRotation: Schema.Boolean,
  allowGlobalMirror: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  timeoutMs: Schema.Number.check(Schema.isGreaterThan(0)),
  workerMode: Schema.Literals(['maxrects-beam-search', 'irregular-convex-v2']),
  historyMode: Schema.Literals(['stream', 'final', 'off']),
  historyScope: Schema.Literal('winning_path'),
  strategySelectionMode: Schema.Literals(['single', 'all_configured']),
  strategyIds: Schema.Array(Schema.String),
  layoutSelectionStrategyId: Schema.String.check(Schema.isMinLength(1)),
  finalSelectionMode: Schema.Literals(['manual', 'best', 'top_n']),
  topN: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  maxHistoryEvents: Schema.optional(Schema.Number),
  irregularSettings: Schema.optional(IrregularNestingSettings)
})

export const NestingOptionsStrictSchema = NestingOptionsStrictFields.check(
  Schema.makeFilter((options) =>
    options.workerMode === 'maxrects-beam-search' && options.strategyIds.length === 0
      ? {
          path: ['strategyIds'],
          issue: 'MaxRects requests require at least one candidate strategy id.'
        }
      : undefined
  )
)

const NestingRequestPieceStrict = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  sourcePieceId: Schema.String.check(Schema.isMinLength(1)),
  realBounds: Schema.Struct({
    x: NonNegativeCoordinate,
    y: NonNegativeCoordinate,
    width: PositiveWidth,
    height: PositiveHeight
  }),
  paddedBounds: RectWith,
  padding: NonNegativePadding,
  allowRotation: Schema.Boolean,
  allowMirror: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  cutRowRef: Schema.optional(
    Schema.Struct({
      reference: Schema.String,
      customerName: Schema.String,
      csvRowId: Schema.String
    })
  )
})

const piecesHaveUniqueIds = Schema.makeFilter<
  ReadonlyArray<Schema.Schema.Type<typeof NestingRequestPieceStrict>>
>((pieces) => {
  const ids = new Set<string>()
  for (const [index, piece] of pieces.entries()) {
    if (ids.has(piece.id)) {
      return { path: [index, 'id'], issue: `Duplicate piece id: ${piece.id}` }
    }
    ids.add(piece.id)
  }
  return undefined
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
  pieces: Schema.Array(NestingRequestPieceStrict).check(Schema.isNonEmpty(), piecesHaveUniqueIds),
  sourcePieces: Schema.optional(Schema.Array(ImportedPiece)),
  options: NestingOptionsStrictSchema,
  strategyRunId: Schema.optional(Schema.String.check(Schema.isMinLength(1)))
})

export const NestingResultStrict = NestingResult
export const WorkerRequestStrict = WorkerRequest
export const WorkerResponseStrict = WorkerResponse

export type { NestingRequest }
export type { NestingResult }
