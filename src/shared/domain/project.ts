import { Schema } from 'effect'
import { SourceFileId } from './ids.js'
import { ImportedPiece, ImportedDxfDocument } from './dxf.js'
import {
  NestingOptions,
  NestingResult,
  ProjectHistoryRef,
  SheetSpec
} from './nesting.js'
import { Millimeters } from './geometry.js'

export const ProjectSourceFileRef = Schema.Struct({
  id: SourceFileId,
  path: Schema.String,
  fileName: Schema.String,
  /** False when the original file is missing on reopen. */
  available: Schema.Boolean
})
export type ProjectSourceFileRef = Schema.Schema.Type<typeof ProjectSourceFileRef>

export const ProjectDocument = Schema.Struct({
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
  padding: Millimeters,
  options: NestingOptions,
  lastResult: Schema.optional(NestingResult),
  lastHistory: Schema.optional(ProjectHistoryRef)
})
export type ProjectDocument = Schema.Schema.Type<typeof ProjectDocument>
