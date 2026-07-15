import { Effect, Schema } from 'effect'
import { JobId, PieceId, SourceFileId } from './ids.js'
import { ImportedPiece, ImportedDxfDocument } from './dxf.js'
import {
  NestingOptions,
  NestingResult,
  NestingSubRun,
  PreparedPiece,
  ProjectHistoryRef,
  SheetSpec
} from './nesting.js'
import { NonNegativeIntegerMillimeters, PositiveIntegerMillimeters } from './geometry.js'

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
  // the run renders against the sheet used when the worker produced it
  sheet: SheetSpec.pipe(
    Schema.withDecodingDefaultTypeKey(
      Effect.succeed({ width: 1000, height: 1000, label: 'legacy run sheet' })
    )
  ),
  result: NestingResult,
  history: Schema.Union([ProjectHistoryRef, Schema.Null])
}) {}

/** One row from an ABAS/CAMQUIX CUT line. */
export class CsvCutRow extends Schema.Class<CsvCutRow>('CsvCutRow')({
  id: PieceId.withDefault,
  reference: Schema.String,
  customerName: Schema.String,
  amount: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  linkedPieceId: Schema.optional(PieceId)
}) {}

/** Default sheet/padding/options for a single CSV run and its subruns. */
export class ProjectRunConfiguration extends Schema.Class<ProjectRunConfiguration>(
  'ProjectRunConfiguration'
)({
  runId: Schema.String,
  label: Schema.String,
  defaultSheet: SheetSpec,
  padding: NonNegativeIntegerMillimeters,
  options: NestingOptions,
  materialFilter: Schema.optional(Schema.String)
}) {}

/** Parsed contents of one imported CSV file. */
export class ProjectCsvImport extends Schema.Class<ProjectCsvImport>('ProjectCsvImport')({
  id: SourceFileId.withDefault,
  sourcePath: Schema.String,
  fileName: Schema.String,
  materialCode: Schema.String,
  materialDescription: Schema.String,
  thicknessMm: PositiveIntegerMillimeters,
  jobDate: Schema.optional(Schema.String),
  rows: Schema.Array(CsvCutRow),
  runConfiguration: ProjectRunConfiguration
}) {}

/** Completed or in-progress run session for one imported CSV. */
export class CsvRunRecord extends Schema.Class<CsvRunRecord>('CsvRunRecord')({
  csvImportId: Schema.String,
  runId: Schema.String,
  label: Schema.String,
  subRuns: Schema.Array(NestingSubRun),
  unplacedPieceIds: Schema.Array(PieceId),
  preparedPieces: Schema.Array(PreparedPiece),
  createdAt: Schema.String,
  updatedAt: Schema.String
}) {}

export class ProjectDocument extends Schema.Class<ProjectDocument>('ProjectDocument')({
  version: Schema.Union([Schema.Literal(1), Schema.Literal(2)]),
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
  /** Per-source eligibility for mirror transforms; missing entries default to enabled. */
  pieceMirrorEnabled: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  options: NestingOptions,
  lastResult: Schema.optional(NestingResult),
  lastHistory: Schema.optional(ProjectHistoryRef),
  runRecords: Schema.optional(Schema.Array(ProjectRunRecord)),
  csvImports: Schema.optional(Schema.Array(ProjectCsvImport)),
  csvRunRecords: Schema.optional(Schema.Array(CsvRunRecord))
}) {}

export class WorkspaceProjectSettings extends Schema.Class<WorkspaceProjectSettings>(
  'WorkspaceProjectSettings'
)({
  revision: Schema.optional(Schema.Number),
  sheet: SheetSpec,
  padding: NonNegativeIntegerMillimeters,
  pieceQuantities: Schema.Record(Schema.String, Schema.Number),
  /** Per-source eligibility for mirror transforms; missing entries default to enabled. */
  pieceMirrorEnabled: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  options: NestingOptions,
  runRecords: Schema.optional(Schema.Array(ProjectRunRecord)),
  selectedCsvId: Schema.optional(Schema.String),
  csvRunRecords: Schema.optional(Schema.Array(CsvRunRecord))
}) {}
