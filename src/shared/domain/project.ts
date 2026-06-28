import { Schema } from 'effect'
import { SourceFileId } from './ids.js'
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
  options: NestingOptions,
  lastResult: Schema.optional(NestingResult),
  lastHistory: Schema.optional(ProjectHistoryRef)
}) {}
