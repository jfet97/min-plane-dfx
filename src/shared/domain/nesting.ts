import { Effect, Schema } from 'effect'
import { FreeRectId, JobId, PieceId } from './ids.js'
import {
  NonNegativeIntegerMillimeters,
  PositiveIntegerMillimeters,
  Rect,
  RectWithFromRect
} from './geometry.js'

/** History scope. Only the winning path is required to be retained. */
export const HistoryScope = Schema.Literal('winning_path')

/** History delivery mode. */
export const HistoryMode = Schema.Literals(['stream', 'final', 'off'])

/** Worker mode currently supported by the local nesting worker. */
export const WorkerMode = Schema.Literal('maxrects-beam-search')

/**
 * Candidate placement strategy selection for a single beam run.
 *   - `single`            -> use exactly the candidate orders in `strategyIds`
 *   - `all_configured`    -> use every candidate order registered in the app
 *
 * These ids are not separate runs. They are candidate-order alternatives used
 * while expanding the same beam.
 */
export const StrategySelectionMode = Schema.Literals(['single', 'all_configured'])

/**
 * Result-envelope selection layer.
 *   - `manual`            -> user picks one result row from the list
 *   - `best`              -> pick the highest-scoring row (criteria TBD)
 *   - `top_n`             -> keep the top N rows as the final candidate set
 *
 * The criteria for "best" / "top N" are intentionally undecided. The app
 * shell must surface the controls as placeholders without picking.
 */
export const FinalSelectionMode = Schema.Literals(['manual', 'best', 'top_n'])

/**
 * Candidate-score prefix name from `strategies.json`.
 * This selects the shared first part of the placement score tuple.
 */
export const StrategyPrefix = Schema.String

/**
 * Candidate-score tail token from `strategies.json`.
 * The worker interprets known tokens like `r`, `s`, `y`, and `x`.
 */
export const StrategyTailToken = Schema.String

export class SheetSpec extends Schema.Class<SheetSpec>('SheetSpec')({
  width: PositiveIntegerMillimeters,
  height: PositiveIntegerMillimeters,
  label: Schema.String
}) {}

// a nesting strategy id is a descriptive string, not an opaque code
export const NestingStrategyId = Schema.String
export type NestingStrategyId = Schema.Schema.Type<typeof NestingStrategyId>

export class NestingStrategyDefinition extends Schema.Class<NestingStrategyDefinition>(
  'NestingStrategyDefinition'
)({
  // stable candidate strategy id saved in project files and requests
  id: Schema.String,
  // short UI label for the candidate strategy
  label: Schema.String,
  // human-readable explanation for tooltips and settings panels
  description: Schema.String,
  // shared global score tuple family, e.g. balanced compactness or short-fill
  prefix: StrategyPrefix,
  // ordered tie-breaker tokens applied after the prefix via `Order.combineAll`
  tail: Schema.Array(StrategyTailToken)
}) {}

export class LayoutSelectionStrategyDefinition extends Schema.Class<LayoutSelectionStrategyDefinition>(
  'LayoutSelectionStrategyDefinition'
)({
  // stable layout selection id saved in project files and requests
  id: Schema.String,
  // short UI label for the beam survivor metric
  label: Schema.String,
  // human-readable explanation for tooltips and settings panels
  description: Schema.String,
  // ordered state-score criteria used after candidate application
  criteria: Schema.Array(Schema.String)
}) {}

export class NestingOptions extends Schema.Class<NestingOptions>('NestingOptions')({
  allowGlobalRotation: Schema.Boolean,
  timeoutMs: Schema.Number,
  workerMode: WorkerMode,
  historyMode: HistoryMode,
  historyScope: HistoryScope,
  strategySelectionMode: StrategySelectionMode,
  // candidate strategy ids used as alternative placement orders inside one beam run
  strategyIds: Schema.Array(Schema.String),
  // layout metric id used to decide which successor beam states survive
  layoutSelectionStrategyId: Schema.String,
  finalSelectionMode: FinalSelectionMode,
  topN: Schema.optional(Schema.Number),
  maxHistoryEvents: Schema.optional(Schema.Number)
}) {}

export class PreparedPiece extends Schema.Class<PreparedPiece>('PreparedPiece')({
  id: PieceId.withDefault,
  sourcePieceId: PieceId,
  realBounds: Rect,
  paddedBounds: RectWithFromRect,
  padding: NonNegativeIntegerMillimeters,
  allowRotation: Schema.Boolean
}) {}

export class NestingRequest extends Schema.Class<NestingRequest>('NestingRequest')({
  version: Schema.Literal(1),
  jobId: JobId.withDefault,
  sheet: SheetSpec,
  padding: NonNegativeIntegerMillimeters,
  pieces: Schema.Array(PreparedPiece),
  options: NestingOptions
}) {}

/** Top-level result status for a completed worker run. */
export const NestingResultStatus = Schema.Literals(['ok', 'partial', 'failed'])

export class Placement extends Schema.Class<Placement>('Placement')({
  pieceId: PieceId,
  x: NonNegativeIntegerMillimeters,
  y: NonNegativeIntegerMillimeters,
  width: PositiveIntegerMillimeters,
  height: PositiveIntegerMillimeters,
  rotation: Schema.Union([Schema.Literal(0), Schema.Literal(90)])
}) {}

export class NestingWarning extends Schema.Class<NestingWarning>('NestingWarning')({
  code: Schema.String,
  message: Schema.String,
  pieceId: Schema.optional(PieceId)
}) {}

export class FinalResultScore extends Schema.Class<FinalResultScore>('FinalResultScore')({
  strategyRunId: Schema.String,
  rank: Schema.optional(Schema.Number),
  tuple: Schema.optional(Schema.Array(Schema.Number)),
  label: Schema.String
}) {}

// status of one result row, distinct from the overall NestingResult.status
export const NestingStrategyStatus = Schema.Literals([
  'completed',
  'partial',
  'failed',
  'cancelled'
])

export class NestingHistorySummary extends Schema.Class<NestingHistorySummary>(
  'NestingHistorySummary'
)({
  frameCount: Schema.Number,
  strategyRunCount: Schema.Number,
  retainedFrameCount: Schema.Number,
  truncated: Schema.Boolean,
  scope: HistoryScope,
  strategyRunIds: Schema.Array(Schema.String),
  ndjsonPath: Schema.optional(Schema.String)
}) {}

export class NestingStats extends Schema.Class<NestingStats>('NestingStats')({
  elapsedMs: Schema.Number,
  pieceCount: Schema.Number
}) {}

export class NestingStrategyResult extends Schema.Class<NestingStrategyResult>(
  'NestingStrategyResult'
)({
  strategyRunId: Schema.String,
  strategyId: NestingStrategyId,
  strategyLabel: Schema.String,
  strategyDescription: Schema.optional(Schema.String),
  status: NestingStrategyStatus,
  sortedPieceIds: Schema.Array(PieceId),
  placements: Schema.Array(Placement),
  unplacedPieceIds: Schema.Array(PieceId),
  historySummary: Schema.optional(NestingHistorySummary),
  finalScore: Schema.optional(FinalResultScore),
  stats: NestingStats,
  warnings: Schema.Array(NestingWarning)
}) {
  static fromAlgorithm(input: {
    readonly strategyRunId: string
    readonly strategyId: NestingStrategyId
    readonly strategyLabel: string
    readonly strategyDescription?: string
    readonly sortedPieceIds: ReadonlyArray<PieceId>
    readonly placements: ReadonlyArray<Placement>
    readonly unplacedPieceIds: ReadonlyArray<PieceId>
    readonly elapsedMs: number
    readonly pieceCount: number
  }): NestingStrategyResult {
    return new NestingStrategyResult({
      strategyRunId: input.strategyRunId,
      strategyId: input.strategyId,
      strategyLabel: input.strategyLabel,
      ...(input.strategyDescription !== undefined
        ? { strategyDescription: input.strategyDescription }
        : {}),
      status: input.unplacedPieceIds.length === 0 ? 'completed' : 'partial',
      sortedPieceIds: input.sortedPieceIds,
      placements: input.placements,
      unplacedPieceIds: input.unplacedPieceIds,
      warnings: [],
      stats: new NestingStats({
        elapsedMs: input.elapsedMs,
        pieceCount: input.pieceCount
      })
    })
  }
}

export class NestingResult extends Schema.Class<NestingResult>('NestingResult')({
  version: Schema.Literal(1),
  jobId: JobId,
  status: NestingResultStatus,
  strategyResults: Schema.Array(NestingStrategyResult),
  selectedStrategyRunId: Schema.optional(Schema.String),
  sortedPieceIds: Schema.Array(PieceId),
  placements: Schema.Array(Placement),
  unplacedPieceIds: Schema.Array(PieceId),
  historySummary: Schema.optional(NestingHistorySummary),
  warnings: Schema.Array(NestingWarning),
  stats: NestingStats
}) {
  static fromAlgorithm(input: {
    readonly request: NestingRequest
    readonly strategyResults: ReadonlyArray<NestingStrategyResult>
    readonly selectedStrategyRunId?: string
    readonly sortedPieceIds: ReadonlyArray<PieceId>
    readonly placements: ReadonlyArray<Placement>
    readonly unplacedPieceIds: ReadonlyArray<PieceId>
    readonly elapsedMs: number
  }): NestingResult {
    return new NestingResult({
      version: 1,
      jobId: input.request.jobId,
      status: input.unplacedPieceIds.length === 0 ? 'ok' : 'partial',
      strategyResults: input.strategyResults,
      ...(input.selectedStrategyRunId !== undefined
        ? { selectedStrategyRunId: input.selectedStrategyRunId }
        : {}),
      sortedPieceIds: input.sortedPieceIds,
      placements: input.placements,
      unplacedPieceIds: input.unplacedPieceIds,
      warnings: [],
      stats: new NestingStats({
        elapsedMs: input.elapsedMs,
        pieceCount: input.request.pieces.length
      })
    })
  }
}

export const FreeRectangleSource = Schema.Union([
  Schema.Literal('initial'),
  Schema.Literal('split'),
  Schema.Literal('pruned'),
  Schema.Literal('algorithm')
])

export class FreeRectangle extends Schema.Class<FreeRectangle>('FreeRectangle')({
  id: FreeRectId.withDefault,
  x: NonNegativeIntegerMillimeters,
  y: NonNegativeIntegerMillimeters,
  width: PositiveIntegerMillimeters,
  height: PositiveIntegerMillimeters,
  source: Schema.optional(FreeRectangleSource)
}) {}

export class PlateSnapshot extends Schema.Class<PlateSnapshot>('PlateSnapshot')({
  placements: Schema.Array(Placement),
  freeRectangles: Schema.Array(FreeRectangle),
  usedBounds: Schema.optional(Rect)
}) {}

export class BeamStateSnapshot extends Schema.Class<BeamStateSnapshot>('BeamStateSnapshot')({
  remainingPieceIds: Schema.Array(PieceId),
  unplacedPieceIds: Schema.Array(PieceId)
}) {}

export class BeamCandidateTrace extends Schema.Class<BeamCandidateTrace>('BeamCandidateTrace')({
  candidateId: Schema.String,
  pieceId: PieceId,
  placement: Schema.optional(Placement),
  score: Schema.optional(Schema.Array(Schema.Number)),
  accepted: Schema.Boolean,
  reason: Schema.optional(Schema.String)
}) {}

export class BeamStepTrace extends Schema.Class<BeamStepTrace>('BeamStepTrace')({
  strategyRunId: Schema.String,
  strategyLabel: Schema.String,
  stepIndex: Schema.Number,
  insertedPieceId: Schema.optional(PieceId),
  beamRank: Schema.Number,
  beamWidth: Schema.Number,
  candidateCount: Schema.optional(Schema.Number),
  selectedCandidateId: Schema.optional(Schema.String)
}) {}

export class FreeRectangleSplitTrace extends Schema.Class<FreeRectangleSplitTrace>(
  'FreeRectangleSplitTrace'
)({
  strategyRunId: Schema.String,
  stepIndex: Schema.Number,
  beamRank: Schema.Number,
  placedPieceId: PieceId,
  before: FreeRectangle,
  after: Schema.Array(FreeRectangle),
  pruned: Schema.Array(FreeRectangle)
}) {}

export class NestingHistoryFrame extends Schema.Class<NestingHistoryFrame>('NestingHistoryFrame')({
  frameId: Schema.String,
  jobId: JobId,
  strategyRunId: Schema.String,
  strategyLabel: Schema.String,
  stepIndex: Schema.Number,
  beamRank: Schema.Number,
  title: Schema.String,
  plate: PlateSnapshot,
  state: BeamStateSnapshot,
  beam: Schema.optional(BeamStepTrace),
  candidates: Schema.optional(Schema.Array(BeamCandidateTrace)),
  freeRectangleSplit: Schema.optional(FreeRectangleSplitTrace),
  createdAt: Schema.String
}) {
  static initial(input: {
    readonly frameId: string
    readonly request: NestingRequest
    readonly strategyRunId: string
    readonly strategyLabel: string
    readonly createdAt: string
  }): NestingHistoryFrame {
    return new NestingHistoryFrame({
      frameId: input.frameId,
      jobId: input.request.jobId,
      strategyRunId: input.strategyRunId,
      strategyLabel: input.strategyLabel,
      stepIndex: 0,
      beamRank: 0,
      title: 'initial-beam',
      plate: new PlateSnapshot({ placements: [], freeRectangles: [] }),
      state: new BeamStateSnapshot({ remainingPieceIds: [], unplacedPieceIds: [] }),
      createdAt: input.createdAt
    })
  }

  static initialBeamSnapshot(input: {
    readonly frameId: string
    readonly request: NestingRequest
    readonly strategyRunId: string
    readonly strategyLabel: string
    readonly beamRank: number
    readonly plate: PlateSnapshot
    readonly state: BeamStateSnapshot
    readonly createdAt: string
  }): NestingHistoryFrame {
    return new NestingHistoryFrame({
      frameId: input.frameId,
      jobId: input.request.jobId,
      strategyRunId: input.strategyRunId,
      strategyLabel: input.strategyLabel,
      stepIndex: 0,
      beamRank: input.beamRank,
      title: 'initial-beam',
      plate: input.plate,
      state: input.state,
      createdAt: input.createdAt
    })
  }
}

export class ProjectHistoryRef extends Schema.Class<ProjectHistoryRef>('ProjectHistoryRef')({
  kind: Schema.Literal('ndjson_replay').pipe(
    Schema.withConstructorDefault(Effect.succeed('ndjson_replay' as const))
  ),
  jobId: JobId,
  path: Schema.String,
  frameCount: Schema.Number,
  createdAt: Schema.String
}) {}
