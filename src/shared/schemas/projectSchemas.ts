import { Schema } from 'effect'
import { ProjectDocument } from '../domain/project.js'
import { ImportedDxfDocument, ImportedPiece } from '../domain/dxf.js'
import { NestingResult } from '../domain/nesting.js'
import { JobId, SourceFileId } from '../domain/ids.js'
import { PositiveWidth, PositiveHeight, NonNegativePadding } from './geometrySchemas.js'

export const ProjectDocumentStrict = Schema.Struct({
  version: Schema.Literal(1),
  savedAt: Schema.String,
  sourceFiles: Schema.Array(
    Schema.Struct({
      id: SourceFileId,
      path: Schema.String,
      fileName: Schema.String,
      available: Schema.Boolean
    })
  ),
  importedPieces: Schema.Array(ImportedPiece),
  importedDocuments: Schema.optional(Schema.Array(ImportedDxfDocument)),
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
  lastResult: Schema.optional(NestingResult),
  lastHistory: Schema.optional(
    Schema.Struct({
      kind: Schema.Literal('ndjson_replay'),
      jobId: JobId,
      path: Schema.String,
      frameCount: Schema.Number,
      createdAt: Schema.String
    })
  )
})

export type { ProjectDocument }
