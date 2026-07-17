import { Data, Effect, Order } from 'effect'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPlacedPiece,
  IrregularPlacementPolicyId,
  IrregularPolygon,
  IrregularNestingSettings,
  IrregularPreparedPiece,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
  IrregularNfpIfpCandidateMemoScope,
  IrregularNfpIfpControl,
  IrregularNfpIfpControlAbortError,
  IrregularNestingNotImplementedError,
  NfpIfpService
} from '../../irregular/services.js'
import {
  compareBalancedCompactnessPlacementScores,
  EDGE_CONTACT_THEN_BALANCED_COMPACTNESS_POLICY_ID,
  IrregularPlacementScorer,
  IrregularPlacementScoringError,
  IrregularPlacementScore
} from './irregularPlacementScorer.js'
import {
  IrregularLayoutScore,
  IrregularLayoutScorer,
  IrregularLayoutScoringError,
  STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT
} from './irregularLayoutScorer.js'
import {
  canonicalCollisionPolygonKey,
  IrregularBeamState,
  type IrregularQuarterTurnDegrees
} from './irregularBeamState.js'
import { canonicalizeIrregularScoreMillimeters } from './irregularScoreGrid.js'
import {
  IrregularDecisionTraceBeamSelection,
  IrregularDecisionTraceBeamStepCompleted,
  IrregularDecisionTraceBeamStepStarted,
  IrregularDecisionTraceCandidateIdRegistry,
  IrregularDecisionTraceDecodeStarted,
  IrregularDecisionTraceDecodeWinner,
  IrregularDecisionTraceEligiblePieces,
  IrregularDecisionTraceLayoutScore,
  IrregularDecisionTraceLocalRepairAccepted,
  IrregularDecisionTraceLocalCandidateScored,
  IrregularDecisionTraceLocalCandidateDecisionCounts,
  IrregularDecisionTraceLocalCandidateSelection,
  IrregularDecisionTraceLocalCandidateSummary,
  IrregularDecisionTraceLocalScore,
  IrregularDecisionTraceParentState,
  IrregularDecisionTracePoint,
  IrregularDecisionTraceSearchSettings,
  IrregularDecisionTraceSheet,
  IrregularDecisionTraceState,
  IrregularDecisionTraceStateIdRegistry,
  IrregularDecisionTraceSuccessorDeduplication,
  IrregularDecisionTraceSuccessorLayoutScored,
  IrregularDecisionTraceTerminalOrientationScored,
  IrregularDecisionTraceTransform,
  IrregularDecisionTraceTransformCandidatesGenerated,
  IrregularDecisionTraceTransformPreference,
  type IrregularDecisionTraceLocalCandidateSelectionReason
} from './decisionTrace.js'
import type {
  EmitIrregularDecisionTrace,
  IrregularDecisionTraceIdentity
} from './decisionTrace.js'

/** The terminal states retained by one deterministic irregular beam run. */
export interface IrregularWindowedBeamResult {
  readonly rankedStates: ReadonlyArray<IrregularBeamState>
  readonly bestState: IrregularBeamState
  readonly bestScore: IrregularLayoutScore
  /** Candidate counts from every completed beam step, also used by snapshot replay. */
  readonly candidateCounts: ReadonlyArray<number>
}

export interface IrregularWindowedBeamHooks {
  readonly onInitialState?: (state: IrregularBeamState) => void
  readonly onStateSelected?: (input: {
    readonly stepIndex: number
    readonly beamRank: number
    readonly state: IrregularBeamState
    readonly candidateCount: number
  }) => void
}

/**
 * Cooperative control shared by every operation in one chromosome decode.
 *
 * The deadline is checked around each transform, candidate batch, and layout
 * score. Search deadlines and cancellation abort the decode. A deadline first
 * observed during terminal repair discards that incomplete repair iteration
 * and returns the last fully scored terminal state.
 */
export interface IrregularWindowedBeamControl {
  readonly deadlineMs?: number
  readonly isCancelled?: () => boolean
}

/** reports only candidate totals from beam steps that completed successfully. */
export interface IrregularWindowedBeamInstrumentation {
  readonly onStepCompleted?: (input: { readonly candidateCount: number }) => void
}

/** typed internal signal used to discard an incomplete chromosome decode. */
export class IrregularWindowedBeamAbortedError extends Data.TaggedError(
  'IrregularWindowedBeamAbortedError'
)<{
  readonly reason: 'deadline' | 'cancelled'
  readonly message: string
}> {}

/** High-level chromosome choices applied by one deterministic beam decode. */
export interface IrregularWindowedBeamOptions {
  readonly policyId?: IrregularPlacementPolicyId
  readonly transformPreferences?: ReadonlyMap<PieceId, number>
}

export type IrregularWindowedBeamError =
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularPlacementScoringError
  | IrregularLayoutScoringError
  | IrregularNfpIfpControlAbortError
  | IrregularWindowedBeamAbortedError

interface LocalCandidate {
  readonly candidate: IrregularPlacementCandidate
  readonly moving: TransformedCollisionGeometry
  readonly score: IrregularPlacementScore
}

interface ScoredState {
  readonly state: IrregularBeamState
  readonly score: IrregularLayoutScore
  readonly key: string
  readonly isIncumbent: boolean
}

interface KeyedState {
  readonly state: IrregularBeamState
  readonly key: string
  readonly isIncumbent: boolean
}

interface TaggedSuccessor {
  readonly state: IrregularBeamState
  readonly isIncumbent: boolean
}

interface ActiveDecisionTrace extends IrregularDecisionTraceIdentity {
  readonly emit: EmitIrregularDecisionTrace
  readonly stateIds: IrregularDecisionTraceStateIdRegistry
  readonly candidateIds: IrregularDecisionTraceCandidateIdRegistry
}

const pieceIdArrayOrder: Order.Order<ReadonlyArray<PieceId>> = Order.Array(Order.String)

const transformOrder = Order.combineAll<IrregularTransformCandidate>([
  Order.mapInput(Order.Number, (transform) => transform.index),
  Order.mapInput(Order.Number, (transform) => transform.rotationDeg),
  Order.mapInput(Order.Boolean, (transform) => transform.mirrored),
  Order.mapInput(Order.String, (transform) => transform.reason)
])

/**
 * Runs bounded reorderings over a supplied priority order.
 *
 * Each branch expands only the configured prefix of its remaining queue. A
 * piece can be bypassed by at most one window of later-priority placements;
 * after that it becomes the branch's only eligible piece. The branch retains a
 * bounded deterministic subset of each selected piece's real legal local
 * candidates. The layout scorer ranks the combined successor states for beam
 * retention.
 */
export function runWindowedIrregularBeam(input: {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
  readonly hooks?: IrregularWindowedBeamHooks
  readonly options?: IrregularWindowedBeamOptions
  readonly control?: IrregularWindowedBeamControl
  readonly instrumentation?: IrregularWindowedBeamInstrumentation
  readonly emitDecisionTrace?: EmitIrregularDecisionTrace
  readonly decisionTraceIdentity?: IrregularDecisionTraceIdentity
}): Effect.Effect<
  IrregularWindowedBeamResult,
  IrregularWindowedBeamError,
  | GeometryKernel
  | GeometrySettings
  | NfpIfpService
  | IrregularPlacementScorer
  | IrregularLayoutScorer
> {
  return Effect.gen(function* () {
    const settings = yield* GeometrySettings
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const placementScorer = yield* IrregularPlacementScorer
    const layoutScorer = yield* IrregularLayoutScorer
    const decisionTrace = makeActiveDecisionTrace(
      input.emitDecisionTrace,
      input.decisionTraceIdentity
    )
    const localCandidateFanout =
      settings.optimizer.localCandidateFanout ?? settings.optimizer.beamWidth
    const localRepairBudget = settings.optimizer.localRepairBudget ?? 0
    const candidateMemoScope = new IrregularNfpIfpCandidateMemoScope()
    const stateKey = (state: IrregularBeamState): string =>
      beamStateKey(state, input.options?.transformPreferences)

    decisionTrace?.emit(new IrregularDecisionTraceDecodeStarted({
      decodeId: decisionTrace.decodeId,
      chromosomeId: decisionTrace.chromosomeId,
      decodeSource: decisionTrace.decodeSource,
      sheet: new IrregularDecisionTraceSheet({
        widthMm: input.sheet.width,
        heightMm: input.sheet.height
      }),
      settings: new IrregularDecisionTraceSearchSettings({
        orderWindow: settings.optimizer.orderWindow,
        beamWidth: settings.optimizer.beamWidth,
        localCandidateFanout,
        localRepairBudget,
        policyId: input.options?.policyId ?? placementScorer.policyId
      }),
      priorityOrder: input.pieces.map((piece) => preparedPieceId(piece)),
      transformPreferences: [...(input.options?.transformPreferences?.entries() ?? [])]
        .toSorted(([first], [second]) => first.localeCompare(second))
        .map(
          ([pieceId, transformIndex]) =>
            new IrregularDecisionTraceTransformPreference({ pieceId, transformIndex })
        )
    }))

    let beam: ReadonlyArray<IrregularBeamState> = [IrregularBeamState.empty(input.pieces)]
    let scoredBeam: ReadonlyArray<ScoredState> | undefined
    const initialPieceRankById = new Map(
      input.pieces.map((piece, index) => [preparedPieceId(piece), index] as const)
    )
    const protectIncumbent = settings.optimizer.beamWidth > 1
    const protectScaleDiverseCompactness = hasScaleDiverseCollisionAreas(input.pieces)
    let incumbentState: IrregularBeamState | undefined = protectIncumbent ? beam[0] : undefined
    const candidateCounts: number[] = []
    const controlState: ControlState = { checkpointsSinceYield: 0 }
    let stepIndex = 0
    while (beam.some((state) => state.remainingPreparedPieces.length > 0)) {
      yield* controlCheckpoint(input.control, controlState)
      decisionTrace?.emit(new IrregularDecisionTraceBeamStepStarted({
        decodeId: decisionTrace.decodeId,
        chromosomeId: decisionTrace.chromosomeId,
        decodeSource: decisionTrace.decodeSource,
        stepIndex,
        parentCount: beam.length
      }))
      const successors: TaggedSuccessor[] = []
      let candidateCount = 0

      for (const [parentIndex, state] of beam.entries()) {
        yield* controlCheckpoint(input.control, controlState)
        const isIncumbent = state === incumbentState
        const parentStateKey = stateKey(state)
        const parentStateId = decisionTrace?.stateIds.idFor(parentStateKey) ?? ''
        decisionTrace?.emit(new IrregularDecisionTraceParentState({
          decodeId: decisionTrace.decodeId,
          chromosomeId: decisionTrace.chromosomeId,
          decodeSource: decisionTrace.decodeSource,
          stepIndex,
          parentRank: parentIndex + 1,
          incumbent: isIncumbent,
          state: decisionTraceState(state, decisionTrace, parentStateKey)
        }))
        const eligiblePieces = selectEligiblePieces(
          state,
          settings.optimizer.orderWindow,
          initialPieceRankById
        )
        decisionTrace?.emit(new IrregularDecisionTraceEligiblePieces({
          decodeId: decisionTrace.decodeId,
          chromosomeId: decisionTrace.chromosomeId,
          decodeSource: decisionTrace.decodeSource,
          stepIndex,
          parentStateId,
          pieceIds: eligiblePieces.map((piece) => preparedPieceId(piece))
        }))
        const legalSuccessors: IrregularBeamState[] = []

        for (const [pieceIndex, piece] of eligiblePieces.entries()) {
          yield* controlCheckpoint(input.control, controlState)
          const localCandidates = yield* collectLocalCandidates({
            sheet: input.sheet,
            settings,
            state,
            piece,
            geometryKernel,
            nfpIfpService,
            placementScorer,
            candidateMemoScope,
            controlState,
            stepIndex,
            parentStateId,
            ...(decisionTrace !== undefined ? { decisionTrace } : {}),
            ...(input.control !== undefined ? { control: input.control } : {}),
            ...(input.options !== undefined ? { options: input.options } : {})
          })
          candidateCount += localCandidates.length
          const selected = selectLocalCandidates(
            localCandidates,
            placementScorer,
            localCandidateFanout,
            protectScaleDiverseCompactness,
            input.options?.transformPreferences?.get(preparedPieceId(piece)),
            decisionTrace,
            stepIndex,
            parentStateId,
            preparedPieceId(piece)
          )
          for (const candidate of selected) {
            yield* controlCheckpoint(input.control, controlState)
            legalSuccessors.push(applyPlacement(state, pieceIndex, piece, candidate))
          }
        }

        if (legalSuccessors.length === 0) {
          successors.push({ state: markFirstRemainingUnplaced(state), isIncumbent })
        } else {
          successors.push(...legalSuccessors.map((state) => ({ state, isIncumbent })))
        }
      }

      const uniqueSuccessors = dedupeRawSuccessors(successors, stateKey, decisionTrace, stepIndex)
      const scored = yield* scoreStates(
        uniqueSuccessors,
        input.sheet,
        layoutScorer,
        input.control,
        controlState,
        decisionTrace,
        stepIndex
      )
      const nextIncumbent = protectIncumbent
        ? selectIncumbentSuccessor(scored, layoutScorer)
        : undefined
      const compactnessSurvivor =
        settings.optimizer.beamWidth >= 4 && protectScaleDiverseCompactness
          ? selectCompactnessSurvivor(scored, layoutScorer)
          : undefined
      scoredBeam = pruneScoredStates(
        scored,
        settings.optimizer.beamWidth,
        layoutScorer,
        nextIncumbent,
        compactnessSurvivor,
        decisionTrace,
        stepIndex
      )
      beam = scoredBeam.map(({ state }) => state)
      incumbentState = nextIncumbent?.state
      candidateCounts.push(candidateCount)
      input.instrumentation?.onStepCompleted?.({ candidateCount })
      decisionTrace?.emit(new IrregularDecisionTraceBeamStepCompleted({
        decodeId: decisionTrace.decodeId,
        chromosomeId: decisionTrace.chromosomeId,
        decodeSource: decisionTrace.decodeSource,
        stepIndex,
        generatedCandidateCount: candidateCount,
        uniqueSuccessorCount: uniqueSuccessors.length,
        retainedStateCount: scoredBeam.length
      }))
      stepIndex += 1
    }

    const ranked = rankScoredStates(
      scoredBeam ??
        (yield* scoreStates(
          beam.map((state) => ({ state, key: stateKey(state), isIncumbent: false })),
          input.sheet,
          layoutScorer,
          input.control,
          controlState,
          decisionTrace,
          stepIndex
        )),
      layoutScorer
    )
    yield* controlCheckpoint(input.control, controlState)
    const initialBest = ranked[0]
    let repairedBest: ScoredState | undefined = initialBest
    if (
      initialBest !== undefined &&
      initialBest.score.unplacedCount === 0 &&
      localRepairBudget > 0
    ) {
      let currentRepair = initialBest
      for (
        let repairIteration = 0;
        repairIteration < localRepairBudget;
        repairIteration += 1
      ) {
        const repairOutcome = yield* repairTerminalState({
          sheet: input.sheet,
          pieces: input.pieces,
          current: currentRepair,
          candidateFanout: localRepairBudget,
          settings,
          geometryKernel,
          nfpIfpService,
          placementScorer,
          layoutScorer,
          candidateMemoScope,
          controlState,
          stepIndex,
          ...(input.control !== undefined ? { control: input.control } : {}),
          ...(input.options !== undefined ? { options: input.options } : {})
        }).pipe(
          Effect.map((accepted) => ({ _tag: 'Completed' as const, accepted })),
          Effect.catchTags({
            IrregularWindowedBeamAbortedError: (error) =>
              error.reason === 'deadline'
                ? Effect.succeed({ _tag: 'DeadlineExpired' as const })
                : Effect.fail(error),
            IrregularNfpIfpControlAbortError: (error) =>
              error.reason === 'deadline'
                ? Effect.succeed({ _tag: 'DeadlineExpired' as const })
                : Effect.fail(error)
          })
        )
        if (repairOutcome._tag === 'DeadlineExpired') break
        const accepted: AcceptedLocalRepair | undefined = repairOutcome.accepted
        if (accepted === undefined) break
        currentRepair = accepted.scoredState
        decisionTrace?.emit(new IrregularDecisionTraceLocalRepairAccepted({
          decodeId: decisionTrace.decodeId,
          chromosomeId: decisionTrace.chromosomeId,
          decodeSource: decisionTrace.decodeSource,
          iterationIndex: repairIteration,
          pieceId: accepted.pieceId,
          state: decisionTraceState(
            currentRepair.state,
            decisionTrace,
            stateKey(currentRepair.state)
          ),
          score: decisionTraceLayoutScore(currentRepair.score)
        }))
      }
      repairedBest = currentRepair
    }
    const terminalBase = repairedBest ?? initialBest
    if (terminalBase === undefined) {
      return yield* Effect.die('windowed irregular beam produced no terminal state')
    }
    const terminalOrientation = yield* selectTerminalOrientation({
      sheet: input.sheet,
      base: terminalBase,
      layoutScorer,
      makeStateKey: stateKey,
      ...(decisionTrace !== undefined ? { decisionTrace } : {})
    })
    const best = terminalOrientation.scoredState
    const finalRanked = [best, ...ranked.slice(1)]
    emitWinningPath(
      input.hooks,
      terminalBase.state,
      candidateCounts,
      terminalOrientation.rotationDeg
    )
    decisionTrace?.emit(new IrregularDecisionTraceDecodeWinner({
      decodeId: decisionTrace.decodeId,
      chromosomeId: decisionTrace.chromosomeId,
      decodeSource: decisionTrace.decodeSource,
      state: decisionTraceState(best.state, decisionTrace, best.key),
      score: decisionTraceLayoutScore(best.score)
    }))
    return {
      rankedStates: finalRanked.map(({ state }) => state),
      bestState: best.state,
      bestScore: best.score,
      candidateCounts
    }
  })
}

interface AcceptedLocalRepair {
  readonly scoredState: ScoredState
  readonly pieceId: PieceId
}

interface TerminalOrientationSelection {
  readonly scoredState: ScoredState
  readonly rotationDeg: IrregularQuarterTurnDegrees
  readonly cornerGapMm: number
}

const TERMINAL_QUARTER_TURNS: ReadonlyArray<IrregularQuarterTurnDegrees> = [0, 90, 180, 270]
const terminalEnvelopeOrder = Order.combineAll<IrregularLayoutScore>([
  Order.mapInput(Order.Number, (score) => score.unplacedCount),
  Order.mapInput(
    Order.Number,
    (score) => score.collisionBoundsWorstNormalizedSheetConsumption
  ),
  Order.mapInput(Order.Number, (score) => score.collisionBoundsNormalizedSpanSum),
  Order.mapInput(Order.Number, (score) => score.collisionBoundsAreaMm2),
  Order.mapInput(Order.Number, (score) => score.collisionBoundsSpanMm),
  Order.mapInput(Order.Number, (score) => score.occupiedHullWasteRatio)
])

function selectTerminalOrientation(input: {
  readonly sheet: SheetSpec
  readonly base: ScoredState
  readonly layoutScorer: IrregularLayoutScorer.Service
  readonly makeStateKey: (state: IrregularBeamState) => string
  readonly decisionTrace?: ActiveDecisionTrace
}): Effect.Effect<TerminalOrientationSelection, IrregularWindowedBeamError> {
  return Effect.gen(function* () {
    const legalVariants: TerminalOrientationSelection[] = []
    for (const rotationDeg of TERMINAL_QUARTER_TURNS) {
      const state = input.base.state.withQuarterTurnBottomLeft(rotationDeg)
      const bounds = state?.translatedCollisionBounds
      if (
        state === undefined ||
        bounds === undefined ||
        bounds.width > input.sheet.width ||
        bounds.height > input.sheet.height
      ) {
        continue
      }
      const cornerGapMm = terminalBottomLeftCornerGapMm(state)
      if (cornerGapMm === undefined) continue
      legalVariants.push({
        scoredState: {
          state,
          score: yield* input.layoutScorer.scoreState({ sheet: input.sheet, state }),
          key: input.makeStateKey(state),
          isIncumbent: false
        },
        rotationDeg,
        cornerGapMm
      })
    }

    const rankedVariants = legalVariants.toSorted((first, second) => {
      const envelopeComparison = terminalEnvelopeOrder(
        first.scoredState.score,
        second.scoredState.score
      )
      if (envelopeComparison !== 0) return envelopeComparison
      const cornerComparison = Order.Number(first.cornerGapMm, second.cornerGapMm)
      if (cornerComparison !== 0) return cornerComparison
      const scoreComparison = input.layoutScorer.compare(
        first.scoredState.score,
        second.scoredState.score
      )
      if (scoreComparison !== 0) return scoreComparison
      return Order.Number(first.rotationDeg, second.rotationDeg)
    })
    const selected = rankedVariants[0]
    if (selected === undefined) {
      return yield* Effect.die('terminal irregular layout has no legal quarter-turn orientation')
    }

    if (input.decisionTrace !== undefined) {
      for (const variant of rankedVariants) {
        input.decisionTrace.emit(new IrregularDecisionTraceTerminalOrientationScored({
          decodeId: input.decisionTrace.decodeId,
          chromosomeId: input.decisionTrace.chromosomeId,
          decodeSource: input.decisionTrace.decodeSource,
          rotationDeg: variant.rotationDeg,
          cornerGapMm: variant.cornerGapMm,
          state: decisionTraceState(
            variant.scoredState.state,
            input.decisionTrace,
            variant.scoredState.key
          ),
          score: decisionTraceLayoutScore(variant.scoredState.score),
          decision: variant === selected ? 'selected' : 'rejected'
        }))
      }
    }
    return selected
  })
}

function terminalBottomLeftCornerGapMm(state: IrregularBeamState): number | undefined {
  let minimumSquaredDistance = Number.POSITIVE_INFINITY
  for (const { placement, collisionGeometry } of state.placedCollisionGeometries) {
    const points = collisionGeometry.polygon.points
    for (let index = 0; index < points.length; index += 1) {
      const first = points[index]
      const second = points[(index + 1) % points.length]
      if (first === undefined || second === undefined) return undefined
      const firstX = first.x + placement.transform.translateX
      const firstY = first.y + placement.transform.translateY
      const secondX = second.x + placement.transform.translateX
      const secondY = second.y + placement.transform.translateY
      const segmentX = secondX - firstX
      const segmentY = secondY - firstY
      const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY
      const projection =
        segmentLengthSquared === 0
          ? 0
          : Math.max(
              0,
              Math.min(1, -(firstX * segmentX + firstY * segmentY) / segmentLengthSquared)
            )
      const nearestX = firstX + projection * segmentX
      const nearestY = firstY + projection * segmentY
      const squaredDistance = nearestX * nearestX + nearestY * nearestY
      if (!Number.isFinite(squaredDistance)) return undefined
      minimumSquaredDistance = Math.min(minimumSquaredDistance, squaredDistance)
    }
  }
  if (!Number.isFinite(minimumSquaredDistance)) return undefined
  return canonicalizeIrregularScoreMillimeters(Math.sqrt(minimumSquaredDistance))
}

function repairTerminalState(input: {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
  readonly current: ScoredState
  readonly candidateFanout: number
  readonly settings: IrregularNestingSettings
  readonly geometryKernel: GeometryKernel.Service
  readonly nfpIfpService: NfpIfpService
  readonly placementScorer: IrregularPlacementScorer.Service
  readonly layoutScorer: IrregularLayoutScorer.Service
  readonly candidateMemoScope: IrregularNfpIfpCandidateMemoScope
  readonly control?: IrregularWindowedBeamControl
  readonly controlState: ControlState
  readonly options?: IrregularWindowedBeamOptions
  readonly stepIndex: number
}): Effect.Effect<AcceptedLocalRepair | undefined, IrregularWindowedBeamError> {
  return Effect.gen(function* () {
    let best: AcceptedLocalRepair | undefined
    const placed = input.current.state.placedCollisionGeometries
    for (const [placedIndex, removed] of placed.entries()) {
      yield* controlCheckpoint(input.control, input.controlState)
      const removedPieceId = removed.placement.pieceId ?? removed.placement.sourcePieceId
      const piece = input.pieces.find(
        (candidate) => preparedPieceId(candidate) === removedPieceId
      )
      if (piece === undefined) continue
      const baseState = new IrregularBeamState({
        remainingPreparedPieces: [piece],
        placedCollisionGeometries: [
          ...placed.slice(0, placedIndex),
          ...placed.slice(placedIndex + 1)
        ],
        unplacedPieceIds: input.current.state.unplacedPieceIds,
        placementOrder: [
          ...input.current.state.placementOrder.slice(0, placedIndex),
          ...input.current.state.placementOrder.slice(placedIndex + 1)
        ]
      })
      const localCandidates = yield* collectLocalCandidates({
        sheet: input.sheet,
        settings: input.settings,
        state: baseState,
        piece,
        geometryKernel: input.geometryKernel,
        nfpIfpService: input.nfpIfpService,
        placementScorer: input.placementScorer,
        candidateMemoScope: input.candidateMemoScope,
        controlState: input.controlState,
        stepIndex: input.stepIndex,
        parentStateId: '',
        ...(input.control !== undefined ? { control: input.control } : {}),
        ...(input.options !== undefined ? { options: input.options } : {})
      })
      const selected = selectLocalCandidates(
        localCandidates,
        input.placementScorer,
        input.candidateFanout,
        hasScaleDiverseCollisionAreas(input.pieces),
        input.options?.transformPreferences?.get(preparedPieceId(piece)),
        undefined,
        input.stepIndex,
        '',
        preparedPieceId(piece)
      )
      for (const candidate of selected) {
        yield* controlCheckpoint(input.control, input.controlState)
        const candidateState = applyPlacement(baseState, 0, piece, candidate)
        const replacement = candidateState.placedCollisionGeometries.at(-1)
        if (replacement === undefined) continue
        const repairedPlaced = [...placed]
        repairedPlaced[placedIndex] = replacement
        const repairedState = new IrregularBeamState({
          remainingPreparedPieces: [],
          placedCollisionGeometries: repairedPlaced,
          unplacedPieceIds: input.current.state.unplacedPieceIds,
          placementOrder: input.current.state.placementOrder,
          parent: input.current.state.parent
        })
        if (
          repairedState.canonicalOccupiedGeometryKey ===
          input.current.state.canonicalOccupiedGeometryKey
        ) {
          continue
        }
        const score = yield* input.layoutScorer.scoreState({
          sheet: input.sheet,
          state: repairedState
        })
        if (input.layoutScorer.compare(score, input.current.score) >= 0) continue
        if (!terminalRepairPreservesEnvelope(score, input.current.score)) continue
        const scoredState = {
          state: repairedState,
          score,
          key: beamStateKey(repairedState, input.options?.transformPreferences),
          isIncumbent: false
        }
        if (
          best === undefined ||
          input.layoutScorer.compare(score, best.scoredState.score) < 0
        ) {
          best = { scoredState, pieceId: removedPieceId }
        }
      }
    }
    return best
  })
}

/** Terminal repair may improve contacts only without enlarging the occupied envelope. */
function terminalRepairPreservesEnvelope(
  candidate: IrregularLayoutScore,
  current: IrregularLayoutScore
): boolean {
  return (
    candidate.collisionBoundsWorstNormalizedSheetConsumption <=
      current.collisionBoundsWorstNormalizedSheetConsumption &&
    candidate.collisionBoundsNormalizedSpanSum <= current.collisionBoundsNormalizedSpanSum &&
    candidate.collisionBoundsAreaMm2 <= current.collisionBoundsAreaMm2 &&
    candidate.collisionBoundsSpanMm <= current.collisionBoundsSpanMm
  )
}

/** Positional decoder alias matching the strict decoder's public shape. */
export function decodeWindowedIrregularBeam(
  sheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  hooks?: IrregularWindowedBeamHooks,
  options?: IrregularWindowedBeamOptions,
  control?: IrregularWindowedBeamControl,
  instrumentation?: IrregularWindowedBeamInstrumentation,
  emitDecisionTrace?: EmitIrregularDecisionTrace,
  decisionTraceIdentity?: IrregularDecisionTraceIdentity
): Effect.Effect<
  IrregularWindowedBeamResult,
  IrregularWindowedBeamError,
  | GeometryKernel
  | GeometrySettings
  | NfpIfpService
  | IrregularPlacementScorer
  | IrregularLayoutScorer
> {
  return runWindowedIrregularBeam({
    sheet,
    pieces,
    ...(hooks !== undefined ? { hooks } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(control !== undefined ? { control } : {}),
    ...(instrumentation !== undefined ? { instrumentation } : {}),
    ...(emitDecisionTrace !== undefined ? { emitDecisionTrace } : {}),
    ...(decisionTraceIdentity !== undefined ? { decisionTraceIdentity } : {})
  })
}

interface ControlState {
  checkpointsSinceYield: number
}

const CHECKPOINTS_PER_EVENT_LOOP_YIELD = 8

function controlCheckpoint(
  control: IrregularWindowedBeamControl | undefined,
  state: ControlState
): Effect.Effect<void, IrregularWindowedBeamAbortedError> {
  if (control === undefined) return Effect.void
  return Effect.gen(function* () {
    const initialReason = controlAbortReason(control)
    if (initialReason !== undefined) return yield* failAborted(initialReason)

    state.checkpointsSinceYield += 1
    if (state.checkpointsSinceYield < CHECKPOINTS_PER_EVENT_LOOP_YIELD) return
    state.checkpointsSinceYield = 0
    yield* yieldToEventLoop()

    const reasonAfterYield = controlAbortReason(control)
    if (reasonAfterYield !== undefined) return yield* failAborted(reasonAfterYield)
  })
}

function controlAbortReason(
  control: IrregularWindowedBeamControl
): 'deadline' | 'cancelled' | undefined {
  if (control.isCancelled?.() === true) return 'cancelled'
  if (control.deadlineMs !== undefined && Date.now() >= control.deadlineMs) return 'deadline'
  return undefined
}

function failAborted(
  reason: 'deadline' | 'cancelled'
): Effect.Effect<never, IrregularWindowedBeamAbortedError> {
  return Effect.fail(
    new IrregularWindowedBeamAbortedError({
      reason,
      message:
        reason === 'deadline'
          ? 'irregular chromosome decode exceeded its cooperative deadline.'
          : 'irregular chromosome decode observed cancellation.'
    })
  )
}

function yieldToEventLoop(): Effect.Effect<void> {
  return Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
  )
}

function collectLocalCandidates(input: {
  readonly sheet: SheetSpec
  readonly settings: IrregularNestingSettings
  readonly state: IrregularBeamState
  readonly piece: IrregularPreparedPiece
  readonly geometryKernel: GeometryKernel.Service
  readonly nfpIfpService: NfpIfpService
  readonly placementScorer: IrregularPlacementScorer.Service
  readonly candidateMemoScope: IrregularNfpIfpCandidateMemoScope
  readonly control?: IrregularWindowedBeamControl
  readonly controlState: ControlState
  readonly options?: IrregularWindowedBeamOptions
  readonly decisionTrace?: ActiveDecisionTrace
  readonly stepIndex: number
  readonly parentStateId: string
}): Effect.Effect<
  ReadonlyArray<LocalCandidate>,
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularPlacementScoringError
  | IrregularNfpIfpControlAbortError
  | IrregularWindowedBeamAbortedError
> {
  return Effect.gen(function* () {
    const candidates: LocalCandidate[] = []
    const nfpControl = makeNfpIfpControl(input.control, input.controlState)
    for (const transform of orderedTransforms(input.piece, input.options?.transformPreferences)) {
      yield* controlCheckpoint(input.control, input.controlState)
      const moving = yield* input.geometryKernel.transformCollisionGeometry({
        geometry: input.piece.collisionGeometry,
        transform
      })
      yield* controlCheckpoint(input.control, input.controlState)
      const candidateInput = {
        sheet: input.sheet,
        placed: input.state.placedCollisionGeometries,
        placedCollisionIndex: input.state.placedCollisionIndex,
        moving,
        settings: input.settings,
        candidateMemoScope: input.candidateMemoScope
      }
      const legalCandidates =
        nfpControl === undefined
          ? yield* input.nfpIfpService.generatePlacementCandidates(candidateInput)
          : yield* input.nfpIfpService.generatePlacementCandidates({
              ...candidateInput,
              control: nfpControl
            })
      yield* controlCheckpoint(input.control, input.controlState)
      input.decisionTrace?.emit(new IrregularDecisionTraceTransformCandidatesGenerated({
        decodeId: input.decisionTrace.decodeId,
        chromosomeId: input.decisionTrace.chromosomeId,
        decodeSource: input.decisionTrace.decodeSource,
        stepIndex: input.stepIndex,
        parentStateId: input.parentStateId,
        pieceId: preparedPieceId(input.piece),
        transform: decisionTraceTransform(transform),
        legalCandidateCount: legalCandidates.length
      }))
      for (const candidate of legalCandidates) {
        yield* controlCheckpoint(input.control, input.controlState)
        const score = yield* input.placementScorer.scoreCandidate({
          sheet: input.sheet,
          placed: input.state.placedCollisionGeometries,
          moving,
          candidate,
          ...(input.options?.policyId !== undefined ? { policyId: input.options.policyId } : {})
        })
        candidates.push({ candidate, moving, score })
        yield* controlCheckpoint(input.control, input.controlState)
      }
    }
    return candidates
  })
}

function selectEligiblePieces(
  state: IrregularBeamState,
  orderWindow: number,
  initialPieceRankById: ReadonlyMap<PieceId, number>
): ReadonlyArray<IrregularPreparedPiece> {
  const eligibleCount = Math.min(orderWindow, state.remainingPreparedPieces.length)
  const window = state.remainingPreparedPieces.slice(0, eligibleCount)
  const first = window[0]
  if (first === undefined || eligibleCount <= 1) return window

  const firstRank = initialPieceRankById.get(preparedPieceId(first))
  if (firstRank === undefined) return window
  const bypassCount = state.placementOrder.reduce((count, placedPieceId) => {
    const placedRank = initialPieceRankById.get(placedPieceId)
    return placedRank !== undefined && placedRank > firstRank ? count + 1 : count
  }, 0)

  return bypassCount >= orderWindow - 1 ? [first] : window
}

/** adapts beam checkpoints to the internal NFP boundary without changing worker cancellation APIs. */
function makeNfpIfpControl(
  control: IrregularWindowedBeamControl | undefined,
  controlState: ControlState
): IrregularNfpIfpControl | undefined {
  if (control === undefined) return undefined
  return {
    checkpoint: () =>
      controlCheckpoint(control, controlState).pipe(
        Effect.mapError(
          (error) =>
            new IrregularNfpIfpControlAbortError({
              reason: error.reason,
              message: error.message
            })
        )
      )
  }
}

function selectLocalCandidates(
  candidates: ReadonlyArray<LocalCandidate>,
  placementScorer: IrregularPlacementScorer.Service,
  maximumCount: number,
  allowAdditionalCompactnessCandidate: boolean,
  preferredTransformIndex: number | undefined,
  decisionTrace: ActiveDecisionTrace | undefined,
  stepIndex: number,
  parentStateId: string,
  pieceId: PieceId
): ReadonlyArray<LocalCandidate> {
  const candidateOrder = Order.combineAll<LocalCandidate>(
    preferredTransformIndex === undefined
      ? [
          Order.make((first, second) => placementScorer.compare(first.score, second.score)),
          Order.mapInput(Order.String, (candidate) => localCandidateKey(candidate))
        ]
      : [
          // preserve the chromosome's transform choice before ranking its local placements
          Order.mapInput(Order.Number, (candidate) =>
            candidate.candidate.transform.index === preferredTransformIndex ? 0 : 1
          ),
          Order.make((first, second) => placementScorer.compare(first.score, second.score)),
          Order.mapInput(Order.String, (candidate) => localCandidateKey(candidate))
        ]
  )
  const allRankedCandidates = candidates.toSorted(candidateOrder)
  const duplicateCandidates = new Set<LocalCandidate>()
  const representativesByGeometry = new Map<string, LocalCandidate>()
  for (const candidate of allRankedCandidates) {
    const geometryKey = localCandidateGeometryKey(candidate)
    if (representativesByGeometry.has(geometryKey)) {
      duplicateCandidates.add(candidate)
    } else {
      representativesByGeometry.set(geometryKey, candidate)
    }
  }
  const rankedCandidates = [...representativesByGeometry.values()]
  const first = rankedCandidates[0]
  let selected: ReadonlyArray<LocalCandidate>
  const compactnessReserved = new Set<LocalCandidate>()
  if (
    maximumCount === 1 ||
    first?.score.policyId !== EDGE_CONTACT_THEN_BALANCED_COMPACTNESS_POLICY_ID
  ) {
    selected = rankedCandidates.slice(0, maximumCount)
  } else {
    const compactnessWinner = rankedCandidates.toSorted(
      Order.combineAll<LocalCandidate>([
        Order.make((first, second) =>
          compareBalancedCompactnessPlacementScores(first.score, second.score)
        ),
        Order.mapInput(Order.String, (candidate) => localCandidateKey(candidate))
      ])
    )[0]
    if (compactnessWinner === undefined) {
      selected = rankedCandidates.slice(0, maximumCount)
    } else {
      const selectedCandidates = [compactnessWinner]
      const selectedKeys = new Set([localCandidateKey(compactnessWinner)])
      for (const candidate of rankedCandidates) {
        if (selectedCandidates.length >= maximumCount) break
        const key = localCandidateKey(candidate)
        if (selectedKeys.has(key)) continue
        selectedCandidates.push(candidate)
        selectedKeys.add(key)
      }
      selected = selectedCandidates
      if (!rankedCandidates.slice(0, maximumCount).includes(compactnessWinner)) {
        compactnessReserved.add(compactnessWinner)
      }
      if (maximumCount >= 4 && allowAdditionalCompactnessCandidate) {
        const additionalCompactnessCandidate = rankedCandidates
          .toSorted(
            Order.combineAll<LocalCandidate>([
              Order.make((first, second) =>
                compareBalancedCompactnessPlacementScores(first.score, second.score)
              ),
              Order.mapInput(Order.String, (candidate) => localCandidateKey(candidate))
            ])
          )
          .find(
            (candidate) =>
              candidate.score.sharedCollisionBoundaryLengthMm > 0 &&
              !selectedCandidates.includes(candidate)
          )
        if (additionalCompactnessCandidate !== undefined) {
          selected = [...selectedCandidates, additionalCompactnessCandidate]
          compactnessReserved.add(additionalCompactnessCandidate)
        }
      }
    }
  }

  if (decisionTrace !== undefined) {
    const selectedCandidates = new Set(selected)
    const detailedDecisions: Array<{
      readonly candidate: LocalCandidate
      readonly rank: number
      readonly decision: 'selected' | 'rejected'
      readonly reason: IrregularDecisionTraceLocalCandidateSelectionReason
    }> = []
    let withinLocalCandidateFanout = 0
    let compactnessAlternativeReserved = 0
    let displacedByCompactnessReservation = 0
    let duplicateLocalGeometry = 0
    let outsideLocalCandidateFanout = 0
    for (const [candidateIndex, candidate] of allRankedCandidates.entries()) {
      const isSelected = selectedCandidates.has(candidate)
      const duplicateGeometry = duplicateCandidates.has(candidate)
      const displacedByReservation =
        !duplicateGeometry &&
        !isSelected &&
        compactnessReserved.size > 0 &&
        rankedCandidates.indexOf(candidate) < maximumCount
      const reason: IrregularDecisionTraceLocalCandidateSelectionReason =
        duplicateGeometry
          ? 'duplicate_local_geometry'
          : compactnessReserved.has(candidate)
            ? 'compactness_alternative_reserved'
            : displacedByReservation
              ? 'displaced_by_compactness_reservation'
              : isSelected
                ? 'within_local_candidate_fanout'
                : 'outside_local_candidate_fanout'
      const isFirstOutsideFanout =
        reason === 'outside_local_candidate_fanout' && outsideLocalCandidateFanout === 0
      switch (reason) {
        case 'within_local_candidate_fanout':
          withinLocalCandidateFanout += 1
          break
        case 'compactness_alternative_reserved':
          compactnessAlternativeReserved += 1
          break
        case 'displaced_by_compactness_reservation':
          displacedByCompactnessReservation += 1
          break
        case 'duplicate_local_geometry':
          duplicateLocalGeometry += 1
          break
        case 'outside_local_candidate_fanout':
          outsideLocalCandidateFanout += 1
          break
      }
      if (isSelected || displacedByReservation || isFirstOutsideFanout) {
        detailedDecisions.push({
          candidate,
          rank: candidateIndex + 1,
          decision: isSelected ? 'selected' : 'rejected',
          reason
        })
      }
    }
    for (const { candidate, rank, decision, reason } of detailedDecisions) {
      const candidateId = decisionTrace.candidateIds.idFor(
        `${localCandidateKey(candidate)}::${rank}`
      )
      decisionTrace.emit(new IrregularDecisionTraceLocalCandidateScored({
        decodeId: decisionTrace.decodeId,
        chromosomeId: decisionTrace.chromosomeId,
        decodeSource: decisionTrace.decodeSource,
        stepIndex,
        parentStateId,
        pieceId,
        candidateId,
        point: new IrregularDecisionTracePoint({
          x: candidate.candidate.point.x,
          y: candidate.candidate.point.y
        }),
        transform: decisionTraceTransform(candidate.candidate.transform),
        policyId: candidate.score.policyId,
        score: decisionTraceLocalScore(candidate.score)
      }))
      decisionTrace.emit(new IrregularDecisionTraceLocalCandidateSelection({
        decodeId: decisionTrace.decodeId,
        chromosomeId: decisionTrace.chromosomeId,
        decodeSource: decisionTrace.decodeSource,
        stepIndex,
        parentStateId,
        pieceId,
        candidateId,
        rank,
        decision,
        reason
      }))
    }
    decisionTrace.emit(new IrregularDecisionTraceLocalCandidateSummary({
      decodeId: decisionTrace.decodeId,
      chromosomeId: decisionTrace.chromosomeId,
      decodeSource: decisionTrace.decodeSource,
      stepIndex,
      parentStateId,
      pieceId,
      generatedCandidateCount: allRankedCandidates.length,
      uniqueGeometryCandidateCount: rankedCandidates.length,
      selectedCandidateCount: selected.length,
      detailedCandidateCount: detailedDecisions.length,
      decisionCounts: new IrregularDecisionTraceLocalCandidateDecisionCounts({
        withinLocalCandidateFanout,
        compactnessAlternativeReserved,
        displacedByCompactnessReservation,
        duplicateLocalGeometry,
        outsideLocalCandidateFanout
      })
    }))
  }
  return selected
}

function applyPlacement(
  state: IrregularBeamState,
  pieceIndex: number,
  piece: IrregularPreparedPiece,
  selected: LocalCandidate
): IrregularBeamState {
  const placementInput = {
    sourcePieceId: piece.source.id,
    placementReference: piece.collisionGeometry.placementReference,
    transform: {
      translateX: selected.candidate.point.x,
      translateY: selected.candidate.point.y,
      rotationDeg: selected.candidate.transform.rotationDeg,
      mirrored: selected.candidate.transform.mirrored
    }
  }
  const placement =
    piece.pieceId === undefined
      ? new IrregularPlacement(placementInput)
      : new IrregularPlacement({ ...placementInput, pieceId: piece.pieceId })
  const placed = new IrregularPlacedPiece({
    placement,
    collisionGeometry: selected.moving
  })
  const pieceId = preparedPieceId(piece)
  return state.withPlacement({
    remainingPreparedPieces: removeAt(state.remainingPreparedPieces, pieceIndex),
    placedCollisionGeometry: placed,
    placementOrderPieceId: pieceId
  })
}

function markFirstRemainingUnplaced(state: IrregularBeamState): IrregularBeamState {
  const first = state.remainingPreparedPieces[0]
  if (first === undefined) return state
  return state.withUnplacedPiece({
    remainingPreparedPieces: state.remainingPreparedPieces.slice(1),
    unplacedPieceId: preparedPieceId(first)
  })
}

function removeAt<A>(values: ReadonlyArray<A>, index: number): ReadonlyArray<A> {
  return [...values.slice(0, index), ...values.slice(index + 1)]
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function orderedTransforms(
  piece: IrregularPreparedPiece,
  transformPreferences: ReadonlyMap<PieceId, number> | undefined
): ReadonlyArray<IrregularTransformCandidate> {
  const ordered = piece.transforms.toSorted(transformOrder)
  const preferredIndex = transformPreferences?.get(preparedPieceId(piece))
  if (preferredIndex === undefined) return ordered
  const preferred = ordered.find((transform) => transform.index === preferredIndex)
  if (preferred === undefined) return fallbackTransforms(ordered)
  return [preferred, ...ordered.filter((transform) => transform !== preferred)]
}

function fallbackTransforms(
  transforms: ReadonlyArray<IrregularTransformCandidate>
): ReadonlyArray<IrregularTransformCandidate> {
  return transforms
}

/** Emits only the branch that produced the final best state, from empty to terminal. */
function emitWinningPath(
  hooks: IrregularWindowedBeamHooks | undefined,
  bestState: IrregularBeamState,
  candidateCounts: ReadonlyArray<number>,
  rotationDeg: IrregularQuarterTurnDegrees
): void {
  if (hooks === undefined) return
  const path = winningStatePath(bestState)
  const initialState = path[0]
  if (initialState !== undefined) {
    hooks.onInitialState?.(
      initialState.withQuarterTurnBottomLeft(rotationDeg) ?? initialState
    )
  }
  for (let index = 1; index < path.length; index += 1) {
    const state = path[index]
    if (state === undefined) continue
    const displayState = state.withQuarterTurnBottomLeft(rotationDeg) ?? state
    hooks.onStateSelected?.({
      stepIndex: index - 1,
      beamRank: 0,
      state: displayState,
      candidateCount: candidateCounts[index - 1] ?? 0
    })
  }
}

/** Walks parent links backward, then restores the natural empty-to-terminal order. */
function winningStatePath(bestState: IrregularBeamState): ReadonlyArray<IrregularBeamState> {
  const reversePath: IrregularBeamState[] = []
  let state: IrregularBeamState | undefined = bestState
  while (state !== undefined) {
    reversePath.push(state)
    state = state.parent
  }
  return reversePath.reverse()
}

function scoreStates(
  states: ReadonlyArray<KeyedState>,
  sheet: SheetSpec,
  layoutScorer: IrregularLayoutScorer.Service,
  control: IrregularWindowedBeamControl | undefined,
  controlState: ControlState,
  decisionTrace: ActiveDecisionTrace | undefined,
  stepIndex: number
): Effect.Effect<
  ReadonlyArray<ScoredState>,
  | IrregularLayoutScoringError
  | IrregularGeometryInputError
  | IrregularNestingNotImplementedError
  | IrregularWindowedBeamAbortedError
> {
  return Effect.gen(function* () {
    const scored: ScoredState[] = []
    for (const { state, key, isIncumbent } of states) {
      yield* controlCheckpoint(control, controlState)
      const score = yield* layoutScorer.scoreState({ sheet, state })
      scored.push({ state, score, key, isIncumbent })
      decisionTrace?.emit(new IrregularDecisionTraceSuccessorLayoutScored({
        decodeId: decisionTrace.decodeId,
        chromosomeId: decisionTrace.chromosomeId,
        decodeSource: decisionTrace.decodeSource,
        stepIndex,
        state: decisionTraceState(state, decisionTrace, key),
        score: decisionTraceLayoutScore(score)
      }))
      yield* controlCheckpoint(control, controlState)
    }
    return scored
  })
}

function dedupeRawSuccessors(
  states: ReadonlyArray<TaggedSuccessor>,
  stateKey: (state: IrregularBeamState) => string,
  decisionTrace: ActiveDecisionTrace | undefined,
  stepIndex: number
): ReadonlyArray<KeyedState> {
  const deduped = new Map<string, KeyedState>()
  const countsByKey = new Map<string, number>()
  for (const { state, isIncumbent } of states) {
    const current = { state, key: stateKey(state), isIncumbent }
    countsByKey.set(current.key, (countsByKey.get(current.key) ?? 0) + 1)
    const previous = deduped.get(current.key)
    if (
      previous === undefined ||
      (current.isIncumbent && !previous.isIncumbent) ||
      (current.isIncumbent === previous.isIncumbent &&
        compareRepresentativeStates(current, previous) < 0)
    ) {
      deduped.set(current.key, current)
    }
  }
  if (decisionTrace !== undefined) {
    for (const { state, isIncumbent } of states) {
      const key = stateKey(state)
      const winner = deduped.get(key)
      const kept = winner?.state === state && winner.isIncumbent === isIncumbent
      decisionTrace.emit(new IrregularDecisionTraceSuccessorDeduplication({
        decodeId: decisionTrace.decodeId,
        chromosomeId: decisionTrace.chromosomeId,
        decodeSource: decisionTrace.decodeSource,
        stepIndex,
        successorStateId: decisionTrace.stateIds.idFor(key),
        decision: kept ? 'kept' : 'dropped',
        reason:
          kept && countsByKey.get(key) === 1
            ? 'unique_successor'
            : kept
              ? 'preferred_dedup_representative'
              : 'duplicate_successor'
      }))
    }
  }
  return [...deduped.values()]
}

function selectIncumbentSuccessor(
  states: ReadonlyArray<ScoredState>,
  layoutScorer: IrregularLayoutScorer.Service
): ScoredState | undefined {
  return rankScoredStates(
    states.filter(({ isIncumbent }) => isIncumbent),
    layoutScorer
  )[0]
}

function pruneScoredStates(
  states: ReadonlyArray<ScoredState>,
  beamWidth: number,
  layoutScorer: IrregularLayoutScorer.Service,
  incumbent: ScoredState | undefined = undefined,
  compactnessSurvivor: ScoredState | undefined = undefined,
  decisionTrace: ActiveDecisionTrace | undefined = undefined,
  stepIndex = 0
): ReadonlyArray<ScoredState> {
  const ranked = rankScoredStates(states, layoutScorer)
  const protectedStates = [incumbent, compactnessSurvivor].filter(
    (state, index, protectedCandidates): state is ScoredState =>
      state !== undefined &&
      protectedCandidates.findIndex((candidate) => candidate?.state === state.state) === index
  )
  const retained = rankScoredStates(
    [
      ...protectedStates,
      ...ranked
        .filter(
          ({ state }) =>
            !protectedStates.some((protectedState) => protectedState.state === state)
        )
        .slice(0, Math.max(0, beamWidth - protectedStates.length))
    ],
    layoutScorer
  )

  if (decisionTrace !== undefined) {
    const retainedStates = new Set(retained.map(({ state }) => state))
    const incumbentRank = ranked.findIndex(({ state }) => state === incumbent?.state)
    const incumbentDisplacedAlternative = incumbentRank >= beamWidth
    const compactnessSurvivorRank = ranked.findIndex(
      ({ state }) => state === compactnessSurvivor?.state
    )
    const compactnessSurvivorDisplacedAlternative = compactnessSurvivorRank >= beamWidth
    for (const [stateIndex, scoredState] of ranked.entries()) {
      const retainedState = retainedStates.has(scoredState.state)
      const protectedIncumbent =
        retainedState && incumbentDisplacedAlternative && scoredState.state === incumbent?.state
      const protectedCompactnessSurvivor =
        retainedState &&
        compactnessSurvivorDisplacedAlternative &&
        scoredState.state === compactnessSurvivor?.state
      const displacedByIncumbent =
        !retainedState && incumbentDisplacedAlternative && stateIndex < beamWidth
      const displacedByCompactnessSurvivor =
        !retainedState && compactnessSurvivorDisplacedAlternative && stateIndex < beamWidth
      decisionTrace.emit(new IrregularDecisionTraceBeamSelection({
        decodeId: decisionTrace.decodeId,
        chromosomeId: decisionTrace.chromosomeId,
        decodeSource: decisionTrace.decodeSource,
        stepIndex,
        stateId: decisionTrace.stateIds.idFor(scoredState.key),
        rank: stateIndex + 1,
        decision: retainedState ? 'retained' : 'pruned',
        reason: protectedIncumbent
          ? 'protected_incumbent'
          : protectedCompactnessSurvivor
            ? 'protected_compactness_survivor'
          : displacedByIncumbent
            ? 'displaced_by_protected_incumbent'
            : displacedByCompactnessSurvivor
              ? 'displaced_by_compactness_survivor'
            : retainedState
              ? 'within_beam_width'
              : 'outside_beam_width'
      }))
    }
  }
  return retained
}

function selectCompactnessSurvivor(
  states: ReadonlyArray<ScoredState>,
  layoutScorer: IrregularLayoutScorer.Service
): ScoredState | undefined {
  const reference = rankScoredStates(states, layoutScorer)[0]
  if (
    reference === undefined ||
    reference.state.placementOrder.length <= STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT
  ) {
    return undefined
  }
  return states
    .filter(
      ({ score }) =>
        score.unplacedCount === reference.score.unplacedCount &&
        score.dominantNearCompleteStructuralContactCount + 1 >=
          reference.score.dominantNearCompleteStructuralContactCount &&
        score.nearCompleteStructuralContactCount + 1 >=
          reference.score.nearCompleteStructuralContactCount
    )
    .toSorted(compactnessStateOrder)[0]
}

const compactnessStateOrder = Order.combineAll<ScoredState>([
  Order.mapInput(Order.Number, ({ score }) => score.collisionBoundsWorstNormalizedSheetConsumption),
  Order.mapInput(Order.Number, ({ score }) => score.collisionBoundsNormalizedSpanSum),
  Order.mapInput(Order.Number, ({ score }) => score.collisionBoundsAreaMm2),
  Order.mapInput(Order.Number, ({ score }) => score.collisionBoundsSpanMm),
  Order.mapInput(Order.Number, ({ score }) => score.occupiedHullWasteRatio),
  Order.mapInput(Order.Number, ({ score }) => score.freeMaterialHoleCount),
  Order.mapInput(Order.String, ({ key }) => key)
])

const MIN_SCALE_DIVERSE_COLLISION_AREA_RATIO = 4

function hasScaleDiverseCollisionAreas(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): boolean {
  let minimumAreaMm2 = Number.POSITIVE_INFINITY
  let maximumAreaMm2 = 0
  for (const piece of pieces) {
    const areaMm2 = collisionPolygonAreaMm2(piece.collisionGeometry.collisionPolygon)
    if (areaMm2 === undefined) return false
    minimumAreaMm2 = Math.min(minimumAreaMm2, areaMm2)
    maximumAreaMm2 = Math.max(maximumAreaMm2, areaMm2)
  }
  return (
    Number.isFinite(minimumAreaMm2) &&
    minimumAreaMm2 > 0 &&
    maximumAreaMm2 >= minimumAreaMm2 * MIN_SCALE_DIVERSE_COLLISION_AREA_RATIO
  )
}

function collisionPolygonAreaMm2(polygon: IrregularPolygon): number | undefined {
  let doubledArea = 0
  for (let index = 0; index < polygon.points.length; index += 1) {
    const first = polygon.points[index]
    const second = polygon.points[(index + 1) % polygon.points.length]
    if (first === undefined || second === undefined) return undefined
    doubledArea += first.x * second.y - second.x * first.y
    if (!Number.isFinite(doubledArea)) return undefined
  }
  const areaMm2 = Math.abs(doubledArea) / 2
  return Number.isFinite(areaMm2) && areaMm2 > 0 ? areaMm2 : undefined
}

function compareRepresentativeStates(first: KeyedState, second: KeyedState): -1 | 0 | 1 {
  const placementOrderComparison = pieceIdArrayOrder(
    first.state.placementOrder,
    second.state.placementOrder
  )
  if (placementOrderComparison !== 0) return placementOrderComparison

  const unplacedOrderComparison = pieceIdArrayOrder(
    first.state.unplacedSourcePieceIds,
    second.state.unplacedSourcePieceIds
  )
  if (unplacedOrderComparison !== 0) return unplacedOrderComparison
  return Order.String(first.key, second.key)
}

function rankScoredStates(
  states: ReadonlyArray<ScoredState>,
  layoutScorer: IrregularLayoutScorer.Service
): ReadonlyArray<ScoredState> {
  return states.toSorted(makeStateOrder(layoutScorer))
}

function makeStateOrder(layoutScorer: IrregularLayoutScorer.Service): Order.Order<ScoredState> {
  return Order.combineAll<ScoredState>([
    Order.make((first, second) => layoutScorer.compare(first.score, second.score)),
    Order.mapInput(Order.String, (state) => state.key)
  ])
}

function localCandidateKey(
  candidate: Pick<LocalCandidate, 'candidate' | 'moving'>
): string {
  const transform = candidate.candidate.transform
  const points = candidate.moving.polygon.points.map((point) => `${point.x}:${point.y}`).join(',')
  return `${candidate.candidate.pieceId}:${candidate.candidate.point.x}:${candidate.candidate.point.y}:${transform.index}:${transform.rotationDeg}:${Number(transform.mirrored)}:${transform.reason}:${points}`
}

function localCandidateGeometryKey(candidate: LocalCandidate): string {
  const translateX = candidate.candidate.point.x
  const translateY = candidate.candidate.point.y
  const canonicalPoints: Array<{ readonly x: number; readonly y: number }> = []
  for (const point of candidate.moving.polygon.points) {
    const x = canonicalizeIrregularScoreMillimeters(point.x + translateX)
    const y = canonicalizeIrregularScoreMillimeters(point.y + translateY)
    if (x === undefined || y === undefined) return localCandidateKey(candidate)
    canonicalPoints.push({ x, y })
  }
  return canonicalCollisionPolygonKey(canonicalPoints)
}

function beamStateKey(
  state: IrregularBeamState,
  transformPreferences: ReadonlyMap<PieceId, number> | undefined
): string {
  const remaining = JSON.stringify(
    state.remainingPreparedPieces.map((piece) =>
      preparedPieceInterchangeabilitySignature(piece, transformPreferences)
    )
  )
  const unplaced = [...state.unplacedPieceIds].toSorted(Order.String).join('|')
  return `${state.canonicalOccupiedGeometryKey}::${remaining}::${unplaced}`
}

function preparedPieceInterchangeabilitySignature(
  piece: IrregularPreparedPiece,
  transformPreferences: ReadonlyMap<PieceId, number> | undefined
): string {
  return JSON.stringify({
    interchangeabilityKey: piece.interchangeabilityKey ?? preparedPieceId(piece),
    allowMirror: piece.allowMirror,
    collisionPolygon: piece.collisionGeometry.collisionPolygon.points,
    transforms: piece.transforms,
    priorityOrderKey: piece.priorityOrderKey ?? null,
    preferredTransformIndex: transformPreferences?.get(preparedPieceId(piece)) ?? null
  })
}

function makeActiveDecisionTrace(
  emit: EmitIrregularDecisionTrace | undefined,
  identity: IrregularDecisionTraceIdentity | undefined
): ActiveDecisionTrace | undefined {
  if (emit === undefined) return undefined
  return {
    emit,
    decodeId: identity?.decodeId ?? 'direct-0',
    chromosomeId: identity?.chromosomeId ?? 'direct',
    decodeSource: identity?.decodeSource ?? 'direct',
    stateIds: new IrregularDecisionTraceStateIdRegistry(),
    candidateIds: new IrregularDecisionTraceCandidateIdRegistry()
  }
}

function decisionTraceTransform(
  transform: IrregularTransformCandidate
): IrregularDecisionTraceTransform {
  return new IrregularDecisionTraceTransform({
    index: transform.index,
    rotationDeg: transform.rotationDeg,
    mirrored: transform.mirrored,
    reason: transform.reason
  })
}

function decisionTraceLocalScore(score: IrregularPlacementScore): IrregularDecisionTraceLocalScore {
  return new IrregularDecisionTraceLocalScore({
    worstNormalizedSheetConsumption: score.worstNormalizedSheetConsumption,
    normalizedSheetSpanSum: score.normalizedSheetSpanSum,
    usedClusterAreaMm2: score.usedClusterAreaMm2,
    usedClusterSpanMm: score.usedClusterSpanMm,
    shortSideFill: score.shortSideFill,
    longSideFill: score.longSideFill,
    sharedCollisionBoundaryLengthMm: score.sharedCollisionBoundaryLengthMm,
    candidateBottomMm: score.candidateBottomMm,
    candidateLeftMm: score.candidateLeftMm
  })
}

function decisionTraceLayoutScore(score: IrregularLayoutScore): IrregularDecisionTraceLayoutScore {
  return new IrregularDecisionTraceLayoutScore({
    unplacedCount: score.unplacedCount,
    sharedCollisionBoundaryLengthMm: score.sharedCollisionBoundaryLengthMm,
    sharedCollisionBoundaryContactUnits: score.sharedCollisionBoundaryContactUnits,
    sharedCollisionBoundaryContactBand: score.sharedCollisionBoundaryContactBand,
    nearCompleteStructuralContactCount: score.nearCompleteStructuralContactCount,
    dominantNearCompleteStructuralContactCount:
      score.dominantNearCompleteStructuralContactCount,
    occupiedHullWasteRatio: score.occupiedHullWasteRatio,
    collisionBoundsWorstNormalizedSheetConsumption:
      score.collisionBoundsWorstNormalizedSheetConsumption,
    collisionBoundsNormalizedSpanSum: score.collisionBoundsNormalizedSpanSum,
    collisionBoundsAreaMm2: score.collisionBoundsAreaMm2,
    collisionBoundsSpanMm: score.collisionBoundsSpanMm,
    largestNetFreeMaterialRegionAreaMm2: score.largestNetFreeMaterialRegionAreaMm2,
    freeMaterialRegionCount: score.freeMaterialRegionCount,
    freeMaterialHoleCount: score.freeMaterialHoleCount,
    freeMaterialSliverMetric: score.freeMaterialSliverMetric,
    collisionBoundsBottomMm: score.collisionBoundsBottomMm,
    collisionBoundsLeftMm: score.collisionBoundsLeftMm
  })
}

function decisionTraceState(
  state: IrregularBeamState,
  decisionTrace: ActiveDecisionTrace,
  stateKey: string
): IrregularDecisionTraceState {
  return new IrregularDecisionTraceState({
    stateId: decisionTrace.stateIds.idFor(stateKey),
    placementOrder: state.placementOrder,
    remainingPieceIds: state.remainingPreparedPieces.map(preparedPieceId),
    unplacedPieceIds: state.unplacedPieceIds
  })
}
