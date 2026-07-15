import { Effect, Schema } from 'effect'
import {
  ProjectDocument,
  ProjectRunRecord,
  ProjectCsvImport,
  CsvRunRecord
} from '../domain/project.js'
import { DxfGeometrySummary, ImportWarning } from '../domain/dxf.js'
import { NestingResult } from '../domain/nesting.js'
import { JobId, PieceId, SourceFileId } from '../domain/ids.js'
import { IrregularNestingSettings } from '../irregular/domain.js'
import {
  NonNegativeCoordinate,
  PositiveWidth,
  PositiveHeight,
  NonNegativePadding
} from './geometrySchemas.js'

const StrictImportedPiece = Schema.Struct({
  id: PieceId,
  sourceFileId: SourceFileId,
  sourceLayer: Schema.optional(Schema.String),
  label: Schema.String,
  realBounds: Schema.Struct({
    x: NonNegativeCoordinate,
    y: NonNegativeCoordinate,
    width: PositiveWidth,
    height: PositiveHeight
  }),
  geometry: DxfGeometrySummary,
  warnings: Schema.Array(ImportWarning)
})

const StrictImportedDxfDocument = Schema.Struct({
  id: SourceFileId,
  path: Schema.String,
  fileName: Schema.String,
  millimetersPerUnit: Schema.Number.check(Schema.isGreaterThan(0)),
  pieces: Schema.Array(StrictImportedPiece),
  warnings: Schema.Array(ImportWarning)
})

export const ProjectDocumentStrict = Schema.Struct({
  version: Schema.Union([Schema.Literal(1), Schema.Literal(2)]),
  savedAt: Schema.String,
  sourceFiles: Schema.Array(
    Schema.Struct({
      id: SourceFileId,
      path: Schema.String,
      fileName: Schema.String,
      available: Schema.Boolean
    })
  ),
  importedPieces: Schema.Array(StrictImportedPiece),
  importedDocuments: Schema.optional(Schema.Array(StrictImportedDxfDocument)),
  sheet: Schema.Struct({
    width: PositiveWidth,
    height: PositiveHeight,
    label: Schema.String
  }),
  padding: NonNegativePadding,
  pieceQuantities: Schema.optional(
    Schema.Record(Schema.String, Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)))
  ),
  pieceMirrorEnabled: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  options: Schema.Struct({
    allowGlobalRotation: Schema.Boolean,
    allowGlobalMirror: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
    timeoutMs: Schema.Number.check(Schema.isGreaterThan(0)),
    workerMode: Schema.Literals(['maxrects-beam-search', 'irregular-convex-v2']),
    historyMode: Schema.Literals(['stream', 'final', 'off']),
    historyScope: Schema.Literal('winning_path'),
    strategySelectionMode: Schema.Literals(['single', 'all_configured']),
    strategyIds: Schema.Array(Schema.String).check(Schema.isNonEmpty()),
    layoutSelectionStrategyId: Schema.String.check(Schema.isMinLength(1)),
    finalSelectionMode: Schema.Literals(['manual', 'best', 'top_n']),
    topN: Schema.optional(Schema.Number),
    maxHistoryEvents: Schema.optional(Schema.Number),
    irregularSettings: Schema.optional(IrregularNestingSettings)
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
  ),
  runRecords: Schema.optional(Schema.Array(ProjectRunRecord)),
  csvImports: Schema.optional(Schema.Array(ProjectCsvImport)),
  csvRunRecords: Schema.optional(Schema.Array(CsvRunRecord))
})

export type { ProjectDocument }
