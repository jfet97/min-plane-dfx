import { Schema } from 'effect'
import { JobId, SourceFileId } from './ids.js'
import { ImportedPiece, ImportedDxfDocument } from './dxf.js'
import { NestingOptions, NestingResult, ProjectHistoryRef, SheetSpec } from './nesting.js'
import { NonNegativeIntegerMillimeters } from './geometry.js'

export class ProjectSourceFileRef extends Schema.Class<ProjectSourceFileRef>(
  'ProjectSourceFileRef'
)({
  id: SourceFileId,
  path: Schema.String,
  fileName: Schema.String,
  /** False when the original file is missing on reopen. */
  available: Schema.Boolean
}) {}

export class ProjectRunRecord extends Schema.Class<ProjectRunRecord>('ProjectRunRecord')({
  jobId: JobId,
  createdAt: Schema.String,
  label: Schema.String,
  pieceCount: Schema.Number,
  result: NestingResult,
  history: Schema.Union([ProjectHistoryRef, Schema.Null])
}) {}

export class ProjectDocument extends Schema.Class<ProjectDocument>('ProjectDocument')({
  version: Schema.Literal(1),
  savedAt: Schema.String,
  sourceFiles: Schema.Array(ProjectSourceFileRef),
  importedPieces: Schema.Array(ImportedPiece),
  /**
   * Original imported documents, kept only for round-tripping history-aware
   * features. Optional: legacy projects may only carry pieces.
   */
  importedDocuments: Schema.optional(Schema.Array(ImportedDxfDocument)),
  sheet: SheetSpec,
  padding: NonNegativeIntegerMillimeters,
  pieceQuantities: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  options: NestingOptions,
  lastResult: Schema.optional(NestingResult),
  lastHistory: Schema.optional(ProjectHistoryRef),
  runRecords: Schema.optional(Schema.Array(ProjectRunRecord))
}) {}

export class WorkspaceProjectSettings extends Schema.Class<WorkspaceProjectSettings>(
  'WorkspaceProjectSettings'
)({
  revision: Schema.optional(Schema.Number),
  sheet: SheetSpec,
  padding: NonNegativeIntegerMillimeters,
  pieceQuantities: Schema.Record(Schema.String, Schema.Number),
  options: NestingOptions,
  runRecords: Schema.optional(Schema.Array(ProjectRunRecord))
}) {}
