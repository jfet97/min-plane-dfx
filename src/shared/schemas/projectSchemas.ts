import { Schema } from 'effect'
import { ProjectDocument } from '../domain/project.js'
import { PositiveWidth, PositiveHeight, NonNegativePadding } from './geometrySchemas.js'

export const ProjectDocumentStrict = Schema.Struct({
  version: Schema.Literal(1),
  savedAt: Schema.String,
  sourceFiles: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1)),
      path: Schema.String,
      fileName: Schema.String,
      available: Schema.Boolean
    })
  ),
  importedPieces: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1)),
      sourceFileId: Schema.String.check(Schema.isMinLength(1)),
      sourceLayer: Schema.optional(Schema.String),
      label: Schema.String,
      realBounds: Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
        width: PositiveWidth,
        height: PositiveHeight
      }),
      geometry: Schema.Struct({
        entityType: Schema.String,
        closed: Schema.Boolean,
        segments: Schema.Array(
          Schema.Struct({
            kind: Schema.Union([Schema.Literal('line'), Schema.Literal('arc')]),
            x1: Schema.Number,
            y1: Schema.Number,
            x2: Schema.Number,
            y2: Schema.Number,
            cx: Schema.optional(Schema.Number),
            cy: Schema.optional(Schema.Number),
            radius: Schema.optional(Schema.Number),
            startAngle: Schema.optional(Schema.Number),
            endAngle: Schema.optional(Schema.Number)
          })
        )
      }),
      warnings: Schema.Array(
        Schema.Struct({
          code: Schema.String,
          message: Schema.String,
          entityType: Schema.optional(Schema.String),
          entityHandle: Schema.optional(Schema.Union([Schema.String, Schema.Number]))
        })
      )
    })
  ),
  importedDocuments: Schema.optional(Schema.Array(Schema.Unknown)),
  sheet: Schema.Struct({
    width: PositiveWidth,
    height: PositiveHeight,
    label: Schema.String
  }),
  padding: NonNegativePadding,
  options: Schema.Struct({
    allowGlobalRotation: Schema.Boolean,
    timeoutMs: Schema.Number.check(Schema.isGreaterThan(0)),
    workerMode: Schema.Literal('stub'),
    historyMode: Schema.Literals(['stream', 'final', 'off']),
    historyScope: Schema.Literal('winning_path'),
    strategySelectionMode: Schema.Literals(['single', 'all_configured']),
    strategyIds: Schema.Array(Schema.String).check(Schema.isNonEmpty()),
    finalSelectionMode: Schema.Literals(['manual', 'best', 'top_n']),
    topN: Schema.optional(Schema.Number),
    maxHistoryEvents: Schema.optional(Schema.Number)
  }),
  lastResult: Schema.optional(Schema.Unknown),
  lastHistory: Schema.optional(
    Schema.Struct({
      kind: Schema.Literal('ndjson_replay'),
      jobId: Schema.String,
      path: Schema.String,
      frameCount: Schema.Number,
      createdAt: Schema.String
    })
  )
})

export type { ProjectDocument }