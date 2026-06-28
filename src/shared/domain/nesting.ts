import { Schema } from 'effect'
import { FreeRectId, JobId, PieceId } from './ids.js'
import { Millimeters, Rect, RectWithFromRect } from './geometry.js'

/** History scope. Only the winning path is required to be retained. */
export const HistoryScope = Schema.Literal('winning_path')

/** History delivery mode. */
export const HistoryMode = Schema.Literals(['stream', 'final', 'off'])

/** Worker mode. The plan keeps only the stub. */
export const WorkerMode = Schema.Literal('stub')

/**
 * Strategy selection mode for a single nesting run.
 *   - `single`            → run exactly the strategies in `strategyIds`
 *   - `all_configured`    → run every strategy registered in the app
 *
 * The first real algorithm version may use a single strategy; the field
 * exists now so the request payload stays stable when the user wires the
 * multi-strategy layer later.
 */
export const StrategySelectionMode = Schema.Literals(['single', 'all_configured'])

/**
 * Final cross-strategy selection layer.
 *   - `manual`            → user picks one strategy run from the list
 *   - `best`              → pick the highest-scoring run (criteria TBD)
 *   - `top_n`             → keep the top N runs as the final candidate set
 *
 * The criteria for "best" / "top N" are intentionally undecided. The app
 * shell must surface the controls as placeholders without picking.
 */
export const FinalSelectionMode = Schema.Literals(['manual', 'best', 'top_n'])

/** Naming fragment for a strategy. Free-form string in the data file; the
 *  schema accepts any descriptive string. The default vocabulary
 *  (`balanced_compactness`, `short_side_fill`) is a starting convention, not
 *  a closed set. */
export const StrategyPrefix = Schema.String

/** Single token that composes the strategy id after the prefix. Free-form. */
export const StrategyTailToken = Schema.String

export const SheetSpec = Schema.Struct({
  width: Millimeters,
  height: Millimeters,
  label: Schema.String
})
export type SheetSpec = Schema.Schema.Type<typeof SheetSpec>

/** A nesting strategy id is a descriptive string, not an opaque code. */
export const NestingStrategyId = Schema.String
export type NestingStrategyId = Schema.Schema.Type<typeof NestingStrategyId>

export const NestingStrategyDefinition = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.String,
  prefix: StrategyPrefix,
  tail: Schema.Array(StrategyTailToken)
})
export type NestingStrategyDefinition = Schema.Schema.Type<typeof NestingStrategyDefinition>

export const NestingOptions = Schema.Struct({
  allowGlobalRotation: Schema.Boolean,
  timeoutMs: Schema.Number,
  workerMode: WorkerMode,
  historyMode: HistoryMode,
  historyScope: HistoryScope,
  strategySelectionMode: StrategySelectionMode,
  strategyIds: Schema.Array(Schema.String),
  finalSelectionMode: FinalSelectionMode,
  topN: Schema.optional(Schema.Number),
  maxHistoryEvents: Schema.optional(Schema.Number)
})
export type NestingOptions = Schema.Schema.Type<typeof NestingOptions>

export const PreparedPiece = Schema.Struct({
  id: PieceId,
  sourcePieceId: PieceId,
  realBounds: Rect,
  paddedBounds: RectWithFromRect,
  padding: Millimeters,
  allowRotation: Schema.Boolean
})
export type PreparedPiece = Schema.Schema.Type<typeof PreparedPiece>

export const NestingRequest = Schema.Struct({
  version: Schema.Literal(1),
  jobId: JobId,
  sheet: SheetSpec,
  padding: Millimeters,
  pieces: Schema.Array(PreparedPiece),
  options: NestingOptions
})
export type NestingRequest = Schema.Schema.Type<typeof NestingRequest>

/** Stub result or a future real result; the union stays open for the algorithm. */
export const NestingResultStatus = Schema.Literals(['stub', 'ok', 'partial', 'failed'])

export const Placement = Schema.Struct({
  pieceId: PieceId,
  x: Millimeters,
  y: Millimeters,
  width: Millimeters,
  height: Millimeters,
  rotation: Schema.Union([Schema.Literal(0), Schema.Literal(90)])
})
export type Placement = Schema.Schema.Type<typeof Placement>

export const NestingWarning = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  pieceId: Schema.optional(PieceId)
})
export type NestingWarning = Schema.Schema.Type<typeof NestingWarning>

export const FinalResultScore = Schema.Struct({
  strategyRunId: Schema.String,
  rank: Schema.optional(Schema.Number),
  tuple: Schema.optional(Schema.Array(Schema.Number)),
  label: Schema.String
})
export type FinalResultScore = Schema.Schema.Type<typeof FinalResultScore>

/** Status of a single strategy run, distinct from the overall NestingResult.status. */
export const NestingStrategyStatus = Schema.Literals(['stub', 'completed', 'failed', 'cancelled'])

export const NestingStrategyResult = Schema.Struct({
  strategyRunId: Schema.String,
  strategyId: NestingStrategyId,
  strategyLabel: Schema.String,
  strategyDescription: Schema.optional(Schema.String),
  status: NestingStrategyStatus,
  sortedPieceIds: Schema.Array(PieceId),
  placements: Schema.Array(Placement),
  unplacedPieceIds: Schema.Array(PieceId),
  historySummary: Schema.optional(
    Schema.Struct({
      frameCount: Schema.Number,
      strategyRunCount: Schema.Number,
      retainedFrameCount: Schema.Number,
      truncated: Schema.Boolean,
      scope: HistoryScope,
      strategyRunIds: Schema.Array(Schema.String),
      ndjsonPath: Schema.optional(Schema.String)
    })
  ),
  finalScore: Schema.optional(FinalResultScore),
  stats: Schema.Struct({
    elapsedMs: Schema.Number,
    pieceCount: Schema.Number
  }),
  warnings: Schema.Array(NestingWarning)
})
export type NestingStrategyResult = Schema.Schema.Type<typeof NestingStrategyResult>

export const NestingResult = Schema.Struct({
  version: Schema.Literal(1),
  jobId: JobId,
  status: NestingResultStatus,
  strategyResults: Schema.Array(NestingStrategyResult),
  selectedStrategyRunId: Schema.optional(Schema.String),
  sortedPieceIds: Schema.Array(PieceId),
  placements: Schema.Array(Placement),
  unplacedPieceIds: Schema.Array(PieceId),
  historySummary: Schema.optional(
    Schema.Struct({
      frameCount: Schema.Number,
      strategyRunCount: Schema.Number,
      retainedFrameCount: Schema.Number,
      truncated: Schema.Boolean,
      scope: HistoryScope,
      strategyRunIds: Schema.Array(Schema.String),
      ndjsonPath: Schema.optional(Schema.String)
    })
  ),
  warnings: Schema.Array(NestingWarning),
  stats: Schema.Struct({
    elapsedMs: Schema.Number,
    pieceCount: Schema.Number
  })
})
export type NestingResult = Schema.Schema.Type<typeof NestingResult>

export const FreeRectangle = Schema.Struct({
  id: FreeRectId,
  x: Millimeters,
  y: Millimeters,
  width: Millimeters,
  height: Millimeters,
  source: Schema.optional(
    Schema.Union([
      Schema.Literal('initial'),
      Schema.Literal('split'),
      Schema.Literal('pruned'),
      Schema.Literal('algorithm')
    ])
  )
})
export type FreeRectangle = Schema.Schema.Type<typeof FreeRectangle>

export const PlateSnapshot = Schema.Struct({
  placements: Schema.Array(Placement),
  freeRectangles: Schema.Array(FreeRectangle),
  usedBounds: Schema.optional(Rect)
})
export type PlateSnapshot = Schema.Schema.Type<typeof PlateSnapshot>

export const BeamCandidateTrace = Schema.Struct({
  candidateId: Schema.String,
  pieceId: PieceId,
  placement: Schema.optional(Placement),
  score: Schema.optional(Schema.Array(Schema.Number)),
  accepted: Schema.Boolean,
  reason: Schema.optional(Schema.String)
})
export type BeamCandidateTrace = Schema.Schema.Type<typeof BeamCandidateTrace>

export const BeamStepTrace = Schema.Struct({
  strategyRunId: Schema.String,
  strategyLabel: Schema.String,
  stepIndex: Schema.Number,
  insertedPieceId: Schema.optional(PieceId),
  beamRank: Schema.Number,
  beamWidth: Schema.Number,
  candidateCount: Schema.optional(Schema.Number),
  selectedCandidateId: Schema.optional(Schema.String)
})
export type BeamStepTrace = Schema.Schema.Type<typeof BeamStepTrace>

export const FreeRectangleSplitTrace = Schema.Struct({
  strategyRunId: Schema.String,
  stepIndex: Schema.Number,
  beamRank: Schema.Number,
  placedPieceId: PieceId,
  before: FreeRectangle,
  after: Schema.Array(FreeRectangle),
  pruned: Schema.Array(FreeRectangle)
})
export type FreeRectangleSplitTrace = Schema.Schema.Type<typeof FreeRectangleSplitTrace>

export const NestingHistoryFrame = Schema.Struct({
  frameId: Schema.String,
  jobId: JobId,
  strategyRunId: Schema.String,
  strategyLabel: Schema.String,
  stepIndex: Schema.Number,
  beamRank: Schema.Number,
  title: Schema.String,
  plate: PlateSnapshot,
  beam: Schema.optional(BeamStepTrace),
  candidates: Schema.optional(Schema.Array(BeamCandidateTrace)),
  freeRectangleSplit: Schema.optional(FreeRectangleSplitTrace),
  createdAt: Schema.String
})
export type NestingHistoryFrame = Schema.Schema.Type<typeof NestingHistoryFrame>

export const NestingHistorySummary = Schema.Struct({
  frameCount: Schema.Number,
  strategyRunCount: Schema.Number,
  retainedFrameCount: Schema.Number,
  truncated: Schema.Boolean,
  scope: HistoryScope,
  strategyRunIds: Schema.Array(Schema.String),
  ndjsonPath: Schema.optional(Schema.String)
})
export type NestingHistorySummary = Schema.Schema.Type<typeof NestingHistorySummary>

export const ProjectHistoryRef = Schema.Struct({
  kind: Schema.Literal('ndjson_replay'),
  jobId: JobId,
  path: Schema.String,
  frameCount: Schema.Number,
  createdAt: Schema.String
})
export type ProjectHistoryRef = Schema.Schema.Type<typeof ProjectHistoryRef>
