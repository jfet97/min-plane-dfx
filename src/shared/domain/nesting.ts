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

/** Worker mode. The plan keeps only the stub. */
export const WorkerMode = Schema.Literal('stub')

/**
 * Strategy selection mode for a single nesting run.
 *   - `single`            -> run exactly the strategies in `strategyIds`
 *   - `all_configured`    -> run every strategy registered in the app
 *
 * The first real algorithm version may use a single strategy; the field
 * exists now so the request payload stays stable when the user wires the
 * multi-strategy layer later.
 */
export const StrategySelectionMode = Schema.Literals(['single', 'all_configured'])

/**
 * Final cross-strategy selection layer.
 *   - `manual`            -> user picks one strategy run from the list
 *   - `best`              -> pick the highest-scoring run (criteria TBD)
 *   - `top_n`             -> keep the top N runs as the final candidate set
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

export class SheetSpec extends Schema.Class<SheetSpec>('SheetSpec')({
  width: PositiveIntegerMillimeters,
  height: PositiveIntegerMillimeters,
  label: Schema.String
}) {}

/** A nesting strategy id is a descriptive string, not an opaque code. */
export const NestingStrategyId = Schema.String
export type NestingStrategyId = Schema.Schema.Type<typeof NestingStrategyId>

export class NestingStrategyDefinition extends Schema.Class<NestingStrategyDefinition>(
  'NestingStrategyDefinition'
)({
  id: Schema.String,
  label: Schema.String,
  description: Schema.String,
  prefix: StrategyPrefix,
  tail: Schema.Array(StrategyTailToken)
}) {}

export class NestingOptions extends Schema.Class<NestingOptions>('NestingOptions')({
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

/** Stub result or a future real result; the union stays open for the algorithm. */
export const NestingResultStatus = Schema.Literals(['stub', 'ok', 'partial', 'failed'])

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
}) {
  static algorithmNotImplemented(strategyId?: string): NestingWarning {
    return new NestingWarning({
      code: 'algorithm_not_implemented',
      message:
        strategyId === undefined
          ? 'The nesting algorithm is intentionally not implemented yet.'
          : `Strategy "${strategyId}" is intentionally not implemented yet.`
    })
  }
}

export class FinalResultScore extends Schema.Class<FinalResultScore>('FinalResultScore')({
  strategyRunId: Schema.String,
  rank: Schema.optional(Schema.Number),
  tuple: Schema.optional(Schema.Array(Schema.Number)),
  label: Schema.String
}) {}

/** Status of a single strategy run, distinct from the overall NestingResult.status. */
export const NestingStrategyStatus = Schema.Literals(['stub', 'completed', 'failed', 'cancelled'])

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
  static stub(input: {
    readonly strategyRunId: string
    readonly strategyId: NestingStrategyId
    readonly strategyLabel: string
    readonly strategyDescription?: string
    readonly sortedPieceIds: ReadonlyArray<PieceId>
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
      status: 'stub',
      sortedPieceIds: input.sortedPieceIds,
      placements: [],
      unplacedPieceIds: input.sortedPieceIds,
      warnings: [NestingWarning.algorithmNotImplemented(input.strategyId)],
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
  static stub(input: {
    readonly request: NestingRequest
    readonly strategyResults: ReadonlyArray<NestingStrategyResult>
    readonly selectedStrategyRunId?: string
    readonly sortedPieceIds: ReadonlyArray<PieceId>
    readonly placements?: ReadonlyArray<Placement>
    readonly unplacedPieceIds?: ReadonlyArray<PieceId>
    readonly elapsedMs: number
  }): NestingResult {
    return new NestingResult({
      version: 1,
      jobId: input.request.jobId,
      status: 'stub',
      strategyResults: input.strategyResults,
      ...(input.selectedStrategyRunId !== undefined
        ? { selectedStrategyRunId: input.selectedStrategyRunId }
        : {}),
      sortedPieceIds: input.sortedPieceIds,
      placements: input.placements ?? [],
      unplacedPieceIds: input.unplacedPieceIds ?? input.sortedPieceIds,
      warnings: [NestingWarning.algorithmNotImplemented()],
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
      title: 'stub-initial',
      plate: new PlateSnapshot({ placements: [], freeRectangles: [] }),
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
    readonly createdAt: string
  }): NestingHistoryFrame {
    return new NestingHistoryFrame({
      frameId: input.frameId,
      jobId: input.request.jobId,
      strategyRunId: input.strategyRunId,
      strategyLabel: input.strategyLabel,
      stepIndex: 0,
      beamRank: input.beamRank,
      title: 'stub-initial',
      plate: input.plate,
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
