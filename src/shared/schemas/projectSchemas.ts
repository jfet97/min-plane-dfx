import { Schema } from 'effect'
import {
  ProjectDocument,
  WorkspaceProjectSettings,
  ProjectCsvImport,
  CsvRunRecord
} from '../domain/project.js'
import { DxfGeometrySummary, ImportWarning } from '../domain/dxf.js'
import { NestingResult } from '../domain/nesting.js'
import { JobId, PieceId, SourceFileId } from '../domain/ids.js'
import { NestingOptionsStrictSchema, NestingRequestStrict } from './nestingSchemas.js'
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

const StrictSheetSpec = Schema.Struct({
  width: PositiveWidth,
  height: PositiveHeight,
  label: Schema.String
})

const StrictProjectHistoryRef = Schema.Struct({
  kind: Schema.Literal('ndjson_replay'),
  jobId: JobId,
  path: Schema.String,
  frameCount: Schema.Number,
  createdAt: Schema.String
})

const StrictProjectRunRecord = Schema.Struct({
  jobId: JobId,
  createdAt: Schema.String,
  label: Schema.String,
  pieceCount: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  sheet: StrictSheetSpec,
  result: NestingResult,
  history: Schema.Union([StrictProjectHistoryRef, Schema.Null]),
  request: Schema.optional(NestingRequestStrict)
})

export const WorkspaceProjectSettingsStrict = Schema.Struct({
  revision: Schema.optional(Schema.Number),
  sheet: StrictSheetSpec,
  padding: NonNegativePadding,
  pieceQuantities: Schema.Record(
    Schema.String,
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  pieceMirrorEnabled: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  options: NestingOptionsStrictSchema,
  runRecords: Schema.optional(Schema.Array(StrictProjectRunRecord)),
  selectedCsvId: Schema.optional(Schema.String),
  csvRunRecords: Schema.optional(Schema.Array(CsvRunRecord))
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
  sheet: StrictSheetSpec,
  padding: NonNegativePadding,
  pieceQuantities: Schema.optional(
    Schema.Record(Schema.String, Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)))
  ),
  pieceMirrorEnabled: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  options: NestingOptionsStrictSchema,
  lastResult: Schema.optional(NestingResult),
  lastHistory: Schema.optional(StrictProjectHistoryRef),
  runRecords: Schema.optional(Schema.Array(StrictProjectRunRecord)),
  csvImports: Schema.optional(Schema.Array(ProjectCsvImport)),
  csvRunRecords: Schema.optional(Schema.Array(CsvRunRecord))
})

export type { ProjectDocument, WorkspaceProjectSettings }
