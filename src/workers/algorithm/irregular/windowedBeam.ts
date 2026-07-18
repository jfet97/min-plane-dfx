import { Data, Effect, Order } from 'effect'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPlacedPiece,
  IrregularPlacementPolicyId,
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
  compareIntrinsicCompactnessPlacementScores,
  EDGE_CONTACT_THEN_BALANCED_COMPACTNESS_POLICY_ID,
  IrregularPlacementScorer,
  IrregularPlacementScoringError,
  IrregularPlacementScore
} from './irregularPlacementScorer.js'
import {
  deriveRawOccupiedHullWasteRatio,
  IrregularLayoutScore,
  IrregularLayoutScorer,
  IrregularLayoutScoringError,
  STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT,
  STRUCTURAL_CONTACT_COUNT_BAND_WIDTH
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

interface LocalCandidateSelection {
  readonly production: ReadonlyArray<LocalCandidate>
  readonly protectedIntrinsic: LocalCandidate | undefined
  readonly protectedPareto: ReadonlyArray<LocalCandidate>
}

interface ScoredState {
  readonly state: IrregularBeamState
  readonly score: IrregularLayoutScore
  readonly rawOccupiedHullWasteRatio: number
  readonly intrinsicMaxSideMm: number
  readonly intrinsicGeometryKey: string
  readonly key: string
  readonly isIncumbent: boolean
  readonly eligibleForProductionLane: boolean
  readonly eligibleForProtectedLane: boolean
  readonly eligibleForProtectedIntrinsicLane: boolean
  readonly eligibleForProtectedParetoFrontierLane: boolean
}

interface KeyedState {
  readonly state: IrregularBeamState
  readonly key: string
  readonly isIncumbent: boolean
  readonly eligibleForProductionLane: boolean
  readonly eligibleForProtectedLane: boolean
  readonly eligibleForProtectedIntrinsicLane: boolean
  readonly eligibleForProtectedParetoFrontierLane: boolean
}

interface TaggedSuccessor {
  readonly state: IrregularBeamState
  readonly isIncumbent: boolean
  readonly eligibleForProductionLane: boolean
  readonly eligibleForProtectedLane: boolean
  readonly eligibleForProtectedIntrinsicLane: boolean
  readonly eligibleForProtectedParetoFrontierLane: boolean
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
    const protectedDiversityEnabled =
      (input.options?.transformPreferences?.size === undefined ||
        input.options.transformPreferences.size === 0) &&
      localRepairBudget === 0
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
    let incumbentState: IrregularBeamState | undefined = protectIncumbent ? beam[0] : undefined
    let productionBeamStates = new Set(beam)
    let boundaryAnchorStates: ReadonlyArray<IrregularBeamState> = []
    let intrinsicContactStates: ReadonlyArray<IrregularBeamState> = []
    let paretoFrontierStates: ReadonlyArray<IrregularBeamState> = []
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
      const protectedBoundaryParents = new Set(boundaryAnchorStates)
      const protectedIntrinsicParents = new Set(intrinsicContactStates)
      const protectedParetoFrontierParents = new Set(paretoFrontierStates)
      let candidateCount = 0

      for (const [parentIndex, state] of beam.entries()) {
        yield* controlCheckpoint(input.control, controlState)
        const isIncumbent = state === incumbentState
        const eligibleForProductionLane = productionBeamStates.has(state)
        const eligibleForProtectedLane = protectedBoundaryParents.has(state)
        const eligibleForProtectedIntrinsicLane = protectedIntrinsicParents.has(state)
        const eligibleForProtectedParetoFrontierLane =
          protectedParetoFrontierParents.has(state)
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
        const legalSuccessors: TaggedSuccessor[] = []

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
            state,
            localCandidates,
            placementScorer,
            localCandidateFanout,
            input.options?.transformPreferences?.get(preparedPieceId(piece)),
            protectedDiversityEnabled,
            decisionTrace,
            stepIndex,
            parentStateId,
            preparedPieceId(piece)
          )
          for (const candidate of selected.production) {
            yield* controlCheckpoint(input.control, controlState)
            legalSuccessors.push({
              state: applyPlacement(state, pieceIndex, piece, candidate),
              isIncumbent,
              eligibleForProductionLane,
              eligibleForProtectedLane,
              eligibleForProtectedIntrinsicLane:
                eligibleForProtectedIntrinsicLane || candidate === selected.protectedIntrinsic,
              eligibleForProtectedParetoFrontierLane:
                eligibleForProtectedParetoFrontierLane ||
                selected.protectedPareto.includes(candidate)
            })
          }
          if (
            selected.protectedIntrinsic !== undefined &&
            !selected.production.includes(selected.protectedIntrinsic)
          ) {
            yield* controlCheckpoint(input.control, controlState)
            legalSuccessors.push({
              state: applyPlacement(
                state,
                pieceIndex,
                piece,
                selected.protectedIntrinsic
              ),
              isIncumbent: false,
              eligibleForProductionLane: false,
              eligibleForProtectedLane: false,
              eligibleForProtectedIntrinsicLane: true,
              eligibleForProtectedParetoFrontierLane: false
            })
          }
          for (const candidate of selected.protectedPareto) {
            if (selected.production.includes(candidate)) continue
            yield* controlCheckpoint(input.control, controlState)
            legalSuccessors.push({
              state: applyPlacement(state, pieceIndex, piece, candidate),
              isIncumbent: false,
              eligibleForProductionLane: false,
              eligibleForProtectedLane: false,
              eligibleForProtectedIntrinsicLane: false,
              eligibleForProtectedParetoFrontierLane: true
            })
          }
        }

        if (legalSuccessors.length === 0) {
          successors.push({
            state: markFirstRemainingUnplaced(state),
            isIncumbent,
            eligibleForProductionLane,
            eligibleForProtectedLane,
            eligibleForProtectedIntrinsicLane,
            eligibleForProtectedParetoFrontierLane
          })
        } else {
          successors.push(...legalSuccessors)
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
      const rankedBoundaryAnchorSuccessors = rankBoundaryAnchorSuccessors(
        scored,
        boundaryAnchorStates
      )
      const nextBoundaryAnchors = rankedBoundaryAnchorSuccessors.slice(
        0,
        PROTECTED_LEGACY_BOUNDARY_LANE_WIDTH
      )
      const rankedIntrinsicContactSuccessors = rankIntrinsicContactSuccessors(scored)
      const nextIntrinsicContacts = rankedIntrinsicContactSuccessors.slice(
        0,
        PROTECTED_INTRINSIC_CONTACT_LANE_WIDTH
      )
      const rankedParetoFrontierSuccessors = rankParetoFrontierSuccessors(scored)
      const nextParetoFrontier = rankedParetoFrontierSuccessors.slice(
        0,
        PROTECTED_PARETO_FRONTIER_LANE_WIDTH
      )
      const pruned = pruneScoredStates(
        scored,
        settings.optimizer.beamWidth,
        input.sheet,
        layoutScorer,
        nextIncumbent,
        nextBoundaryAnchors,
        rankedBoundaryAnchorSuccessors,
        nextIntrinsicContacts,
        rankedIntrinsicContactSuccessors,
        nextParetoFrontier,
        rankedParetoFrontierSuccessors,
        protectedDiversityEnabled,
        decisionTrace,
        stepIndex
      )
      scoredBeam = pruned.retained
      beam = scoredBeam.map(({ state }) => state)
      incumbentState = nextIncumbent?.state
      productionBeamStates = new Set(pruned.productionSurvivors.map(({ state }) => state))
      boundaryAnchorStates = pruned.boundaryAnchorSurvivors.map(({ state }) => state)
      intrinsicContactStates = pruned.intrinsicContactSurvivors.map(({ state }) => state)
      paretoFrontierStates = pruned.paretoFrontierSurvivors.map(({ state }) => state)
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

    const terminalStates =
      scoredBeam ??
        (yield* scoreStates(
          beam.map((state) => ({
            state,
            key: stateKey(state),
            isIncumbent: false,
            eligibleForProductionLane: productionBeamStates.has(state),
            eligibleForProtectedLane: boundaryAnchorStates.includes(state),
            eligibleForProtectedIntrinsicLane: intrinsicContactStates.includes(state),
            eligibleForProtectedParetoFrontierLane: paretoFrontierStates.includes(state)
          })),
          input.sheet,
          layoutScorer,
          input.control,
          controlState,
          decisionTrace,
          stepIndex
        ))
    const ranked = rankScoredStates(terminalStates, layoutScorer)
    const productionRanked = rankScoredStates(
      terminalStates.filter(({ eligibleForProductionLane }) => eligibleForProductionLane),
      layoutScorer
    )
    const boundaryProtectedRanked = rankScoredStates(
      terminalStates.filter(({ eligibleForProtectedLane }) => eligibleForProtectedLane),
      layoutScorer
    )
    const intrinsicProtectedRanked = rankScoredStates(
      terminalStates.filter(
        ({ eligibleForProtectedIntrinsicLane }) => eligibleForProtectedIntrinsicLane
      ),
      layoutScorer
    )
    const paretoFrontierProtectedRanked = rankScoredStates(
      terminalStates.filter(
        ({ eligibleForProtectedParetoFrontierLane }) => eligibleForProtectedParetoFrontierLane
      ),
      layoutScorer
    )
    const protectedRanked = rankScoredStates(
      terminalStates.filter(
        ({
          eligibleForProtectedLane,
          eligibleForProtectedIntrinsicLane,
          eligibleForProtectedParetoFrontierLane
        }) =>
          eligibleForProtectedLane ||
          eligibleForProtectedIntrinsicLane ||
          eligibleForProtectedParetoFrontierLane
      ),
      layoutScorer
    )
    yield* controlCheckpoint(input.control, controlState)
    const initialBest = productionRanked[0] ?? protectedRanked[0]
    let repairedBest: ScoredState | undefined = initialBest
    let terminalRepairDeadlineExpired = false
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
        if (repairOutcome._tag === 'DeadlineExpired') {
          terminalRepairDeadlineExpired = true
          break
        }
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
    const productionTerminalBase = repairedBest ?? initialBest
    if (productionTerminalBase === undefined) {
      return yield* Effect.die('windowed irregular beam produced no terminal state')
    }
    const protectedTerminalBases =
      localRepairBudget === 0
        ? uniqueScoredStates([
            boundaryProtectedRanked.find((state) => state !== initialBest),
            intrinsicProtectedRanked.find((state) => state !== initialBest),
            paretoFrontierProtectedRanked.find((state) => state !== initialBest)
          ])
        : []
    const terminalOrientationControl = terminalRepairDeadlineExpired
      ? input.control?.isCancelled === undefined
        ? undefined
        : { isCancelled: input.control.isCancelled }
      : input.control
    const productionOrientation = yield* selectTerminalOrientation({
      sheet: input.sheet,
      base: productionTerminalBase,
      layoutScorer,
      makeStateKey: stateKey,
      controlState,
      ...(terminalOrientationControl !== undefined
        ? { control: terminalOrientationControl }
        : {})
    })
    const protectedOrientations: ProtectedTerminalOrientation[] = []
    for (const base of protectedTerminalBases) {
      const orientation = yield* selectTerminalOrientation({
        sheet: input.sheet,
        base,
        layoutScorer,
        makeStateKey: stateKey,
        controlState,
        ...(terminalOrientationControl !== undefined
          ? { control: terminalOrientationControl }
          : {})
      })
      if (
        selectParetoSafeProtectedWinner(
          productionOrientation.scoredState,
          orientation.scoredState,
          layoutScorer
        ) === orientation.scoredState
      ) {
        protectedOrientations.push({ base, orientation })
      }
    }
    const selectedOrientedState = rankScoredStates(
      [
        productionOrientation.scoredState,
        ...protectedOrientations.map(({ orientation }) => orientation.scoredState)
      ],
      layoutScorer
    )[0]
    if (selectedOrientedState === undefined || initialBest === undefined) {
      return yield* Effect.die('windowed irregular beam selected no terminal state')
    }
    const selectedProtectedOrientation = protectedOrientations.find(
      ({ orientation }) => orientation.scoredState === selectedOrientedState
    )
    const selectedTerminalBase = selectedProtectedOrientation?.base ?? productionTerminalBase
    const selectedInitialState = selectedProtectedOrientation?.base ?? initialBest
    const terminalOrientation =
      selectedProtectedOrientation?.orientation ?? productionOrientation
    emitTerminalOrientationTrace(decisionTrace, terminalOrientation)
    const best = terminalOrientation.scoredState
    const finalRanked = [best, ...ranked.filter((state) => state !== selectedInitialState)]
    emitWinningPath(
      input.hooks,
      selectedTerminalBase.state,
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

interface TerminalOrientationCandidate {
  readonly scoredState: ScoredState
  readonly rotationDeg: IrregularQuarterTurnDegrees
  readonly cornerGapMm: number
}

interface TerminalOrientationSelection extends TerminalOrientationCandidate {
  readonly evaluatedVariants: ReadonlyArray<TerminalOrientationCandidate>
}

interface ProtectedTerminalOrientation {
  readonly base: ScoredState
  readonly orientation: TerminalOrientationSelection
}

const TERMINAL_QUARTER_TURNS: ReadonlyArray<IrregularQuarterTurnDegrees> = [0, 90, 180, 270]

function selectTerminalOrientation(input: {
  readonly sheet: SheetSpec
  readonly base: ScoredState
  readonly layoutScorer: IrregularLayoutScorer.Service
  readonly makeStateKey: (state: IrregularBeamState) => string
  readonly control?: IrregularWindowedBeamControl
  readonly controlState: ControlState
}): Effect.Effect<TerminalOrientationSelection, IrregularWindowedBeamError> {
  return Effect.gen(function* () {
    const legalVariants: TerminalOrientationCandidate[] = []
    for (const rotationDeg of TERMINAL_QUARTER_TURNS) {
      yield* controlCheckpoint(input.control, input.controlState)
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
      const score = yield* input.layoutScorer.scoreState({ sheet: input.sheet, state })
      const rawOccupiedHullWasteRatio =
        deriveRawOccupiedHullWasteRatio(state) ?? score.occupiedHullWasteRatio
      yield* controlCheckpoint(input.control, input.controlState)
      legalVariants.push({
        scoredState: {
          state,
          score,
          rawOccupiedHullWasteRatio,
          intrinsicMaxSideMm: intrinsicStateMaxSideMm(state),
          intrinsicGeometryKey: intrinsicStateGeometryKey(state),
          key: input.makeStateKey(state),
          isIncumbent: false,
          eligibleForProductionLane: input.base.eligibleForProductionLane,
          eligibleForProtectedLane: input.base.eligibleForProtectedLane,
          eligibleForProtectedIntrinsicLane:
            input.base.eligibleForProtectedIntrinsicLane,
          eligibleForProtectedParetoFrontierLane:
            input.base.eligibleForProtectedParetoFrontierLane
        },
        rotationDeg,
        cornerGapMm
      })
    }

    const rankedVariants = legalVariants.toSorted((first, second) => {
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
    return { ...selected, evaluatedVariants: rankedVariants }
  })
}

function emitTerminalOrientationTrace(
  decisionTrace: ActiveDecisionTrace | undefined,
  selection: TerminalOrientationSelection
): void {
  if (decisionTrace === undefined) return
  for (const variant of selection.evaluatedVariants) {
    decisionTrace.emit(new IrregularDecisionTraceTerminalOrientationScored({
      decodeId: decisionTrace.decodeId,
      chromosomeId: decisionTrace.chromosomeId,
      decodeSource: decisionTrace.decodeSource,
      rotationDeg: variant.rotationDeg,
      cornerGapMm: variant.cornerGapMm,
      state: decisionTraceState(variant.scoredState.state, decisionTrace, variant.scoredState.key),
      score: decisionTraceLayoutScore(variant.scoredState.score),
      decision: variant.scoredState === selection.scoredState ? 'selected' : 'rejected'
    }))
  }
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
        baseState,
        localCandidates,
        input.placementScorer,
        input.candidateFanout,
        input.options?.transformPreferences?.get(preparedPieceId(piece)),
        false,
        undefined,
        input.stepIndex,
        '',
        preparedPieceId(piece)
      )
      for (const candidate of selected.production) {
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
          rawOccupiedHullWasteRatio:
            deriveRawOccupiedHullWasteRatio(repairedState) ?? score.occupiedHullWasteRatio,
          intrinsicMaxSideMm: intrinsicStateMaxSideMm(repairedState),
          intrinsicGeometryKey: intrinsicStateGeometryKey(repairedState),
          key: beamStateKey(repairedState, input.options?.transformPreferences),
          isIncumbent: false,
          eligibleForProductionLane: input.current.eligibleForProductionLane,
          eligibleForProtectedLane: input.current.eligibleForProtectedLane,
          eligibleForProtectedIntrinsicLane:
            input.current.eligibleForProtectedIntrinsicLane,
          eligibleForProtectedParetoFrontierLane:
            input.current.eligibleForProtectedParetoFrontierLane
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
  state: IrregularBeamState,
  candidates: ReadonlyArray<LocalCandidate>,
  placementScorer: IrregularPlacementScorer.Service,
  maximumCount: number,
  preferredTransformIndex: number | undefined,
  enableProtectedIntrinsic: boolean,
  decisionTrace: ActiveDecisionTrace | undefined,
  stepIndex: number,
  parentStateId: string,
  pieceId: PieceId
): LocalCandidateSelection {
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
  let compactnessReserved: LocalCandidate | undefined
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
        compactnessReserved = compactnessWinner
      }
    }
  }

  const protectedIntrinsic =
    enableProtectedIntrinsic &&
    maximumCount >= 3 &&
    first?.score.policyId === EDGE_CONTACT_THEN_BALANCED_COMPACTNESS_POLICY_ID
      ? selectProtectedIntrinsicContactCandidate(state, selected, rankedCandidates)
      : undefined
  const intrinsicReserved =
    protectedIntrinsic !== undefined && !selected.includes(protectedIntrinsic)
      ? protectedIntrinsic
      : undefined
  const protectedPareto =
    enableProtectedIntrinsic &&
    maximumCount >= 3 &&
    first?.score.policyId === EDGE_CONTACT_THEN_BALANCED_COMPACTNESS_POLICY_ID
      ? selectProtectedParetoFrontierCandidates(state, selected, rankedCandidates)
      : []
  const paretoReserved = protectedPareto.filter((candidate) => !selected.includes(candidate))

  if (decisionTrace !== undefined) {
    const selectedCandidates = new Set([
      ...selected,
      ...(intrinsicReserved === undefined ? [] : [intrinsicReserved]),
      ...paretoReserved
    ])
    const detailedDecisions: Array<{
      readonly candidate: LocalCandidate
      readonly rank: number
      readonly decision: 'selected' | 'rejected'
      readonly reason: IrregularDecisionTraceLocalCandidateSelectionReason
    }> = []
    let withinLocalCandidateFanout = 0
    let compactnessAlternativeReserved = 0
    let displacedByCompactnessReservation = 0
    let intrinsicContactTierReserved = 0
    let paretoFrontierReserved = 0
    let duplicateLocalGeometry = 0
    let outsideLocalCandidateFanout = 0
    for (const [candidateIndex, candidate] of allRankedCandidates.entries()) {
      const isSelected = selectedCandidates.has(candidate)
      const duplicateGeometry = duplicateCandidates.has(candidate)
      const displacedByReservation =
        !duplicateGeometry &&
        !isSelected &&
        compactnessReserved !== undefined &&
        rankedCandidates.indexOf(candidate) < maximumCount
      const reason: IrregularDecisionTraceLocalCandidateSelectionReason =
        duplicateGeometry
          ? 'duplicate_local_geometry'
          : candidate === intrinsicReserved
            ? 'intrinsic_contact_tier_reserved'
            : paretoReserved.includes(candidate)
              ? 'pareto_frontier_reserved'
              : candidate === compactnessReserved
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
        case 'intrinsic_contact_tier_reserved':
          intrinsicContactTierReserved += 1
          break
        case 'pareto_frontier_reserved':
          paretoFrontierReserved += 1
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
      selectedCandidateCount: selectedCandidates.size,
      detailedCandidateCount: detailedDecisions.length,
      decisionCounts: new IrregularDecisionTraceLocalCandidateDecisionCounts({
        withinLocalCandidateFanout,
        compactnessAlternativeReserved,
        displacedByCompactnessReservation,
        intrinsicContactTierReserved,
        paretoFrontierReserved,
        duplicateLocalGeometry,
        outsideLocalCandidateFanout
      })
    }))
  }
  return { production: selected, protectedIntrinsic, protectedPareto }
}

function selectProtectedIntrinsicContactCandidate(
  state: IrregularBeamState,
  selected: ReadonlyArray<LocalCandidate>,
  rankedCandidates: ReadonlyArray<LocalCandidate>
): LocalCandidate | undefined {
  const selectedByContactLength = groupLocalCandidatesByContactLength(selected)
  const candidatesByContactLength = groupLocalCandidatesByContactLength(rankedCandidates)
  const intrinsicOrder = Order.combineAll<LocalCandidate>([
    Order.make((first, second) =>
      compareIntrinsicCompactnessPlacementScores(first.score, second.score)
    ),
    Order.mapInput(Order.String, (candidate) =>
      intrinsicLocalCandidateGeometryKey(state, candidate)
    )
  ])
  const eligibleContactLengths = [...selectedByContactLength.entries()]
    .filter(
      ([contactLength, candidates]) => contactLength > 0 && candidates.length >= 2
    )
    .map(([contactLength]) => contactLength)
    .toSorted((first, second) => second - first)

  for (const contactLength of eligibleContactLengths) {
    const candidateTier = candidatesByContactLength.get(contactLength)
    if (candidateTier === undefined) continue
    const intrinsicWinner = candidateTier.toSorted(intrinsicOrder)[0]
    if (intrinsicWinner !== undefined) return intrinsicWinner
  }
  return undefined
}

/**
 * Keeps the bounded non-dominated orientation families production evicted.
 *
 * Exact contact ties never dominate each other, so a rotated twin with
 * identical intrinsic compactness survives next to the production winner.
 */
function selectProtectedParetoFrontierCandidates(
  state: IrregularBeamState,
  selected: ReadonlyArray<LocalCandidate>,
  rankedCandidates: ReadonlyArray<LocalCandidate>
): ReadonlyArray<LocalCandidate> {
  const selectedByContactLength = groupLocalCandidatesByContactLength(selected)
  const candidatesByContactLength = groupLocalCandidatesByContactLength(rankedCandidates)
  const intrinsicOrder = Order.combineAll<LocalCandidate>([
    Order.make((first, second) =>
      compareIntrinsicCompactnessPlacementScores(first.score, second.score)
    ),
    Order.mapInput(Order.String, (candidate) =>
      intrinsicLocalCandidateGeometryKey(state, candidate)
    )
  ])
  const eligibleContactLengths = [...selectedByContactLength.entries()]
    .filter(([, candidates]) => candidates.length >= 2)
    .map(([contactLength]) => contactLength)
    .toSorted((first, second) => second - first)

  const picks: LocalCandidate[] = []
  const pickedGeometryKeys = new Set<string>()
  for (const contactLength of eligibleContactLengths) {
    const candidateTier = candidatesByContactLength.get(contactLength)
    if (candidateTier === undefined) continue
    const nonDominated = candidateTier.filter(
      (candidate) => !isLocallyParetoDominated(candidate, candidateTier)
    )
    for (const candidate of nonDominated.toSorted(intrinsicOrder)) {
      if (picks.length >= PROTECTED_PARETO_FRONTIER_LOCAL_SEED_LIMIT) return picks
      if (selected.includes(candidate)) continue
      const geometryKey = intrinsicLocalCandidateGeometryKey(state, candidate)
      if (pickedGeometryKeys.has(geometryKey)) continue
      pickedGeometryKeys.add(geometryKey)
      picks.push(candidate)
    }
  }
  return picks
}

/** Exact ties never dominate: domination needs one strictly smaller objective. */
function isLocallyParetoDominated(
  candidate: LocalCandidate,
  tier: ReadonlyArray<LocalCandidate>
): boolean {
  return tier.some(
    (other) =>
      other !== candidate &&
      other.score.usedClusterMaxSideMm <= candidate.score.usedClusterMaxSideMm &&
      other.score.usedClusterAreaMm2 <= candidate.score.usedClusterAreaMm2 &&
      other.score.usedClusterSpanMm <= candidate.score.usedClusterSpanMm &&
      (other.score.usedClusterMaxSideMm < candidate.score.usedClusterMaxSideMm ||
        other.score.usedClusterAreaMm2 < candidate.score.usedClusterAreaMm2 ||
        other.score.usedClusterSpanMm < candidate.score.usedClusterSpanMm)
  )
}

function intrinsicLocalCandidateGeometryKey(
  state: IrregularBeamState,
  candidate: LocalCandidate
): string {
  const absoluteRings = [
    ...state.placedCollisionGeometries.map(({ placement, collisionGeometry }) =>
      collisionGeometry.polygon.points.map((point) => ({
        x: point.x + placement.transform.translateX,
        y: point.y + placement.transform.translateY
      }))
    ),
    candidate.moving.polygon.points.map((point) => ({
      x: point.x + candidate.candidate.point.x,
      y: point.y + candidate.candidate.point.y
    }))
  ]
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const ring of absoluteRings) {
    for (const point of ring) {
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
    }
  }
  return JSON.stringify(
    absoluteRings
      .map((ring) =>
        canonicalCollisionPolygonKey(
          ring.map(({ x, y }) => ({ x: x - minX, y: y - minY }))
        )
      )
      .toSorted()
  )
}

function groupLocalCandidatesByContactLength(
  candidates: ReadonlyArray<LocalCandidate>
): ReadonlyMap<number, ReadonlyArray<LocalCandidate>> {
  const grouped = new Map<number, LocalCandidate[]>()
  for (const candidate of candidates) {
    const contactLength = candidate.score.sharedCollisionBoundaryLengthMm
    const tier = grouped.get(contactLength)
    if (tier === undefined) grouped.set(contactLength, [candidate])
    else tier.push(candidate)
  }
  return grouped
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

function intrinsicStateMaxSideMm(state: IrregularBeamState): number {
  const bounds = state.translatedCollisionBounds
  if (bounds === undefined) return 0
  const width = canonicalizeIrregularScoreMillimeters(bounds.width)
  const height = canonicalizeIrregularScoreMillimeters(bounds.height)
  if (width === undefined || height === undefined) return Number.POSITIVE_INFINITY
  return Math.max(width, height)
}

function intrinsicStateGeometryKey(state: IrregularBeamState): string {
  const bounds = state.translatedCollisionBounds
  if (bounds === undefined) return '[]'
  const canonicalRings = state.placedCollisionGeometries.map(
    ({ placement, collisionGeometry }) =>
      canonicalCollisionPolygonKey(
        collisionGeometry.polygon.points.map((point) => ({
          x: point.x + placement.transform.translateX - bounds.minX,
          y: point.y + placement.transform.translateY - bounds.minY
        }))
      )
  )
  return JSON.stringify(canonicalRings.toSorted())
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
    for (const {
      state,
      key,
      isIncumbent,
      eligibleForProductionLane,
      eligibleForProtectedLane,
      eligibleForProtectedIntrinsicLane,
      eligibleForProtectedParetoFrontierLane
    } of states) {
      yield* controlCheckpoint(control, controlState)
      const score = yield* layoutScorer.scoreState({ sheet, state })
      const rawOccupiedHullWasteRatio =
        deriveRawOccupiedHullWasteRatio(state) ?? score.occupiedHullWasteRatio
      scored.push({
        state,
        score,
        rawOccupiedHullWasteRatio,
        intrinsicMaxSideMm: intrinsicStateMaxSideMm(state),
        intrinsicGeometryKey: intrinsicStateGeometryKey(state),
        key,
        isIncumbent,
        eligibleForProductionLane,
        eligibleForProtectedLane,
        eligibleForProtectedIntrinsicLane,
        eligibleForProtectedParetoFrontierLane
      })
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
  for (const {
    state,
    isIncumbent,
    eligibleForProductionLane,
    eligibleForProtectedLane,
    eligibleForProtectedIntrinsicLane,
    eligibleForProtectedParetoFrontierLane
  } of states) {
    const current: KeyedState = {
      state,
      key: stateKey(state),
      isIncumbent,
      eligibleForProductionLane,
      eligibleForProtectedLane,
      eligibleForProtectedIntrinsicLane,
      eligibleForProtectedParetoFrontierLane
    }
    countsByKey.set(current.key, (countsByKey.get(current.key) ?? 0) + 1)
    const previous = deduped.get(current.key)
    if (previous === undefined) {
      deduped.set(current.key, current)
      continue
    }
    const preferCurrent =
      (current.eligibleForProductionLane && !previous.eligibleForProductionLane) ||
      (current.eligibleForProductionLane === previous.eligibleForProductionLane &&
        ((current.isIncumbent && !previous.isIncumbent) ||
          (current.isIncumbent === previous.isIncumbent &&
            compareRepresentativeStates(current, previous) < 0)))
    const preferred = preferCurrent ? current : previous
    deduped.set(current.key, {
      ...preferred,
      eligibleForProductionLane:
        current.eligibleForProductionLane || previous.eligibleForProductionLane,
      eligibleForProtectedLane:
        current.eligibleForProtectedLane || previous.eligibleForProtectedLane,
      eligibleForProtectedIntrinsicLane:
        current.eligibleForProtectedIntrinsicLane ||
        previous.eligibleForProtectedIntrinsicLane,
      eligibleForProtectedParetoFrontierLane:
        current.eligibleForProtectedParetoFrontierLane ||
        previous.eligibleForProtectedParetoFrontierLane
    })
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

function selectParetoSafeProtectedWinner(
  productionWinner: ScoredState | undefined,
  protectedWinner: ScoredState | undefined,
  layoutScorer: IrregularLayoutScorer.Service
): ScoredState | undefined {
  if (productionWinner === undefined) return protectedWinner
  if (protectedWinner === undefined) return productionWinner
  const protectedImprovesArea =
    protectedWinner.score.collisionBoundsAreaMm2 <
    productionWinner.score.collisionBoundsAreaMm2
  const protectedImprovesProductionOrder =
    layoutScorer.compare(protectedWinner.score, productionWinner.score) < 0
  return protectedImprovesArea && protectedImprovesProductionOrder
    ? protectedWinner
    : productionWinner
}

function uniqueScoredStates(
  states: ReadonlyArray<ScoredState | undefined>
): ReadonlyArray<ScoredState> {
  const uniqueStates: ScoredState[] = []
  const seen = new Set<IrregularBeamState>()
  for (const scoredState of states) {
    if (scoredState === undefined || seen.has(scoredState.state)) continue
    seen.add(scoredState.state)
    uniqueStates.push(scoredState)
  }
  return uniqueStates
}

const PROTECTED_LEGACY_BOUNDARY_LANE_WIDTH = 8
const PROTECTED_INTRINSIC_CONTACT_LANE_WIDTH = 1
const PROTECTED_PARETO_FRONTIER_LANE_WIDTH = 2
const PROTECTED_PARETO_FRONTIER_LOCAL_SEED_LIMIT = 2

function rankBoundaryAnchorSuccessors(
  states: ReadonlyArray<ScoredState>,
  boundaryAnchorStates: ReadonlyArray<IrregularBeamState>
): ReadonlyArray<ScoredState> {
  if (boundaryAnchorStates.length === 0) return []
  return states
    .filter(({ eligibleForProtectedLane }) => eligibleForProtectedLane)
    .toSorted(protectedLegacyBoundaryLaneStateOrder)
}

function rankIntrinsicContactSuccessors(
  states: ReadonlyArray<ScoredState>
): ReadonlyArray<ScoredState> {
  return states
    .filter(({ eligibleForProtectedIntrinsicLane }) => eligibleForProtectedIntrinsicLane)
    .toSorted(protectedIntrinsicContactLaneStateOrder)
}

/**
 * Ranks pareto-eligible successors as non-dominated sets per contact tier.
 *
 * Domination never crosses exact contact-strength tiers, so a stronger-contact
 * lineage can never evict a weaker-contact one. Tiers are concatenated by
 * contact strength, then sliced to the lane width by the caller.
 */
function rankParetoFrontierSuccessors(
  states: ReadonlyArray<ScoredState>
): ReadonlyArray<ScoredState> {
  const eligible = states.filter(
    ({ eligibleForProtectedParetoFrontierLane }) => eligibleForProtectedParetoFrontierLane
  )
  const statesByTier = new Map<string, ScoredState[]>()
  for (const state of eligible) {
    const tierKey = paretoFrontierContactTierKey(state)
    const tier = statesByTier.get(tierKey)
    if (tier === undefined) statesByTier.set(tierKey, [state])
    else tier.push(state)
  }
  return [...statesByTier.values()]
    .map((tier) =>
      tier
        .filter((state) => !isParetoFrontierDominated(state, tier))
        .toSorted(protectedParetoFrontierLaneStateOrder)
    )
    .toSorted((first, second) => paretoFrontierTierOrder(first[0], second[0]))
    .flat()
}

interface ParetoFrontierContactTier {
  readonly unplacedCount: number
  readonly dominantNearCompleteStructuralContactCount: number
  readonly tierCount: number
}

function paretoFrontierContactTier(state: ScoredState): ParetoFrontierContactTier {
  const { score } = state
  return {
    unplacedCount: score.unplacedCount,
    dominantNearCompleteStructuralContactCount:
      score.dominantNearCompleteStructuralContactCount,
    tierCount:
      score.placementOrder.length <= STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT
        ? score.nearCompleteStructuralContactCount
        : Math.floor(score.nearCompleteStructuralContactCount / STRUCTURAL_CONTACT_COUNT_BAND_WIDTH)
  }
}

function paretoFrontierContactTierKey(state: ScoredState): string {
  const tier = paretoFrontierContactTier(state)
  return `${tier.unplacedCount}:${tier.dominantNearCompleteStructuralContactCount}:${tier.tierCount}`
}

const paretoFrontierTierStateOrder = Order.combineAll<ParetoFrontierContactTier>([
  Order.mapInput(Order.Number, ({ unplacedCount }) => unplacedCount),
  Order.flip(
    Order.mapInput(
      Order.Number,
      ({ dominantNearCompleteStructuralContactCount }) =>
        dominantNearCompleteStructuralContactCount
    )
  ),
  Order.flip(Order.mapInput(Order.Number, ({ tierCount }) => tierCount))
])

/* Both states of one tier share the same key by construction, so comparing the
   tier of either representative orders the tiers themselves. */
function paretoFrontierTierOrder(
  first: ScoredState | undefined,
  second: ScoredState | undefined
): -1 | 0 | 1 {
  if (first === undefined) return second === undefined ? 0 : 1
  if (second === undefined) return -1
  return paretoFrontierTierStateOrder(paretoFrontierContactTier(first), paretoFrontierContactTier(second))
}

/** Exact ties never dominate: domination needs one strictly smaller objective. */
function isParetoFrontierDominated(
  state: ScoredState,
  tier: ReadonlyArray<ScoredState>
): boolean {
  return tier.some(
    (other) =>
      other !== state &&
      other.intrinsicMaxSideMm <= state.intrinsicMaxSideMm &&
      other.score.collisionBoundsAreaMm2 <= state.score.collisionBoundsAreaMm2 &&
      other.score.collisionBoundsSpanMm <= state.score.collisionBoundsSpanMm &&
      other.score.freeMaterialHoleCount <= state.score.freeMaterialHoleCount &&
      (other.intrinsicMaxSideMm < state.intrinsicMaxSideMm ||
        other.score.collisionBoundsAreaMm2 < state.score.collisionBoundsAreaMm2 ||
        other.score.collisionBoundsSpanMm < state.score.collisionBoundsSpanMm ||
        other.score.freeMaterialHoleCount < state.score.freeMaterialHoleCount)
  )
}

const rawHullWasteStateCriterion: Order.Order<ScoredState> = Order.mapInput(
  Order.Number,
  ({ rawOccupiedHullWasteRatio }) => rawOccupiedHullWasteRatio
)

const protectedLegacyStrictScoreOrder: Order.Order<ScoredState> = Order.combineAll([
  scoredStateCriterion((score) => score.unplacedCount),
  descendingScoredStateCriterion((score) => score.dominantNearCompleteStructuralContactCount),
  descendingScoredStateCriterion((score) => score.nearCompleteStructuralContactCount),
  scoredStateCriterion((score) => score.collisionBoundsWorstNormalizedSheetConsumption),
  scoredStateCriterion((score) => score.collisionBoundsNormalizedSpanSum),
  scoredStateCriterion((score) => score.collisionBoundsAreaMm2),
  scoredStateCriterion((score) => score.collisionBoundsSpanMm),
  rawHullWasteStateCriterion,
  descendingScoredStateCriterion((score) => score.sharedCollisionBoundaryContactBand),
  descendingScoredStateCriterion((score) => score.sharedCollisionBoundaryContactUnits),
  descendingScoredStateCriterion((score) => score.sharedCollisionBoundaryLengthMm),
  scoredStateCriterion((score) => score.collisionBoundsBottomMm),
  scoredStateCriterion((score) => score.collisionBoundsLeftMm),
  descendingScoredStateCriterion((score) => score.largestNetFreeMaterialRegionAreaMm2),
  scoredStateCriterion((score) => score.freeMaterialRegionCount),
  scoredStateCriterion((score) => score.freeMaterialHoleCount),
  scoredStateCriterion((score) => score.freeMaterialSliverMetric),
  Order.mapInput(Order.Array(Order.String), ({ score }) => score.placementOrder),
  Order.mapInput(Order.Array(Order.String), ({ score }) => score.unplacedSourcePieceIds),
  Order.mapInput(Order.String, ({ key }) => key)
])

const protectedLegacyScaleAwareScoreOrder: Order.Order<ScoredState> = Order.combineAll([
  scoredStateCriterion((score) => score.unplacedCount),
  descendingScoredStateCriterion((score) => score.dominantNearCompleteStructuralContactCount),
  Order.flip(
    Order.mapInput(Order.Number, ({ score }: ScoredState) =>
      Math.floor(score.nearCompleteStructuralContactCount / STRUCTURAL_CONTACT_COUNT_BAND_WIDTH)
    )
  ),
  scoredStateCriterion((score) => score.collisionBoundsWorstNormalizedSheetConsumption),
  scoredStateCriterion((score) => score.collisionBoundsNormalizedSpanSum),
  scoredStateCriterion((score) => score.collisionBoundsAreaMm2),
  scoredStateCriterion((score) => score.collisionBoundsSpanMm),
  rawHullWasteStateCriterion,
  descendingScoredStateCriterion((score) => score.nearCompleteStructuralContactCount),
  descendingScoredStateCriterion((score) => score.sharedCollisionBoundaryContactUnits),
  descendingScoredStateCriterion((score) => score.sharedCollisionBoundaryLengthMm),
  scoredStateCriterion((score) => score.collisionBoundsBottomMm),
  scoredStateCriterion((score) => score.collisionBoundsLeftMm),
  descendingScoredStateCriterion((score) => score.largestNetFreeMaterialRegionAreaMm2),
  scoredStateCriterion((score) => score.freeMaterialRegionCount),
  scoredStateCriterion((score) => score.freeMaterialHoleCount),
  scoredStateCriterion((score) => score.freeMaterialSliverMetric),
  Order.mapInput(Order.Array(Order.String), ({ score }) => score.placementOrder),
  Order.mapInput(Order.Array(Order.String), ({ score }) => score.unplacedSourcePieceIds),
  Order.mapInput(Order.String, ({ key }) => key)
])

const protectedLegacyBoundaryLaneStateOrder: Order.Order<ScoredState> = Order.make(
  (first, second) =>
    first.score.placementOrder.length === second.score.placementOrder.length &&
    first.score.placementOrder.length > STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT
      ? protectedLegacyScaleAwareScoreOrder(first, second)
      : protectedLegacyStrictScoreOrder(first, second)
)

const intrinsicMaxSideStateCriterion: Order.Order<ScoredState> = Order.mapInput(
  Order.Number,
  ({ intrinsicMaxSideMm }) => intrinsicMaxSideMm
)

const intrinsicGeometryStateCriterion: Order.Order<ScoredState> = Order.mapInput(
  Order.String,
  ({ intrinsicGeometryKey }) => intrinsicGeometryKey
)

const protectedIntrinsicStrictScoreOrder: Order.Order<ScoredState> = Order.combineAll([
  scoredStateCriterion((score) => score.unplacedCount),
  descendingScoredStateCriterion((score) => score.dominantNearCompleteStructuralContactCount),
  descendingScoredStateCriterion((score) => score.nearCompleteStructuralContactCount),
  descendingScoredStateCriterion((score) => score.sharedCollisionBoundaryContactBand),
  descendingScoredStateCriterion((score) => score.sharedCollisionBoundaryContactUnits),
  descendingScoredStateCriterion((score) => score.sharedCollisionBoundaryLengthMm),
  intrinsicMaxSideStateCriterion,
  scoredStateCriterion((score) => score.collisionBoundsAreaMm2),
  scoredStateCriterion((score) => score.collisionBoundsSpanMm),
  rawHullWasteStateCriterion,
  Order.mapInput(Order.Array(Order.String), ({ score }) => score.placementOrder),
  Order.mapInput(Order.Array(Order.String), ({ score }) => score.unplacedSourcePieceIds),
  intrinsicGeometryStateCriterion
])

const protectedIntrinsicScaleAwareScoreOrder: Order.Order<ScoredState> = Order.combineAll([
  scoredStateCriterion((score) => score.unplacedCount),
  descendingScoredStateCriterion((score) => score.dominantNearCompleteStructuralContactCount),
  Order.flip(
    Order.mapInput(Order.Number, ({ score }: ScoredState) =>
      Math.floor(score.nearCompleteStructuralContactCount / STRUCTURAL_CONTACT_COUNT_BAND_WIDTH)
    )
  ),
  descendingScoredStateCriterion((score) => score.sharedCollisionBoundaryContactUnits),
  descendingScoredStateCriterion((score) => score.sharedCollisionBoundaryLengthMm),
  intrinsicMaxSideStateCriterion,
  scoredStateCriterion((score) => score.collisionBoundsAreaMm2),
  scoredStateCriterion((score) => score.collisionBoundsSpanMm),
  rawHullWasteStateCriterion,
  descendingScoredStateCriterion((score) => score.nearCompleteStructuralContactCount),
  Order.mapInput(Order.Array(Order.String), ({ score }) => score.placementOrder),
  Order.mapInput(Order.Array(Order.String), ({ score }) => score.unplacedSourcePieceIds),
  intrinsicGeometryStateCriterion
])

const protectedIntrinsicContactLaneStateOrder: Order.Order<ScoredState> = Order.make(
  (first, second) =>
    first.score.placementOrder.length === second.score.placementOrder.length &&
    first.score.placementOrder.length > STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT
      ? protectedIntrinsicScaleAwareScoreOrder(first, second)
      : protectedIntrinsicStrictScoreOrder(first, second)
)

/* Sheet-independent within-tier order for the pareto frontier lane: cached
   intrinsic objectives first, then raw hull waste, then deterministic keys. No
   sheet-normalized fields and no sheet-space coordinates participate. */
const protectedParetoFrontierLaneStateOrder: Order.Order<ScoredState> = Order.combineAll([
  intrinsicMaxSideStateCriterion,
  scoredStateCriterion((score) => score.collisionBoundsAreaMm2),
  scoredStateCriterion((score) => score.collisionBoundsSpanMm),
  scoredStateCriterion((score) => score.freeMaterialHoleCount),
  rawHullWasteStateCriterion,
  Order.mapInput(Order.Array(Order.String), ({ score }) => score.placementOrder),
  Order.mapInput(Order.Array(Order.String), ({ score }) => score.unplacedSourcePieceIds),
  intrinsicGeometryStateCriterion
])

function scoredStateCriterion(
  select: (score: IrregularLayoutScore) => number
): Order.Order<ScoredState> {
  return Order.mapInput(Order.Number, ({ score }) => select(score))
}

function descendingScoredStateCriterion(
  select: (score: IrregularLayoutScore) => number
): Order.Order<ScoredState> {
  return Order.flip(scoredStateCriterion(select))
}

function pruneScoredStates(
  states: ReadonlyArray<ScoredState>,
  beamWidth: number,
  sheet: SheetSpec,
  layoutScorer: IrregularLayoutScorer.Service,
  incumbent: ScoredState | undefined = undefined,
  protectedBoundaryAnchors: ReadonlyArray<ScoredState> = [],
  rankedProtectedBoundarySuccessors: ReadonlyArray<ScoredState> = [],
  protectedIntrinsicContacts: ReadonlyArray<ScoredState> = [],
  rankedProtectedIntrinsicSuccessors: ReadonlyArray<ScoredState> = [],
  protectedParetoFrontier: ReadonlyArray<ScoredState> = [],
  rankedParetoFrontierSuccessors: ReadonlyArray<ScoredState> = [],
  preserveBoundaryAnchorDiversity = true,
  decisionTrace: ActiveDecisionTrace | undefined = undefined,
  stepIndex = 0
): {
  readonly retained: ReadonlyArray<ScoredState>
  readonly productionSurvivors: ReadonlyArray<ScoredState>
  readonly boundaryAnchorSurvivors: ReadonlyArray<ScoredState>
  readonly intrinsicContactSurvivors: ReadonlyArray<ScoredState>
  readonly paretoFrontierSurvivors: ReadonlyArray<ScoredState>
} {
  const ranked = rankScoredStates(states, layoutScorer)
  const productionRanked = rankScoredStates(
    states.filter(({ eligibleForProductionLane }) => eligibleForProductionLane),
    layoutScorer
  )
  const baselineRetained =
    beamWidth <= 1 || incumbent === undefined
      ? productionRanked.slice(0, beamWidth)
      : rankScoredStates(
          [
            incumbent,
            ...productionRanked
              .filter(({ state }) => state !== incumbent.state)
              .slice(0, beamWidth - 1)
          ],
          layoutScorer
        )
  const boundaryAnchorSurvivors =
    preserveBoundaryAnchorDiversity && beamWidth > 1
      ? protectedBoundaryAnchors.length > 0
        ? protectedBoundaryAnchors
        : [selectBoundaryAnchorSurvivor(productionRanked, baselineRetained, sheet)].filter(
            (state): state is ScoredState => state !== undefined
          )
      : []
  const intrinsicContactSurvivors =
    preserveBoundaryAnchorDiversity && beamWidth > 1 ? protectedIntrinsicContacts : []
  const paretoFrontierSurvivors =
    preserveBoundaryAnchorDiversity && beamWidth > 1 ? protectedParetoFrontier : []
  const retained = rankScoredStates(
    [
      ...baselineRetained,
      ...boundaryAnchorSurvivors.filter((state) => !baselineRetained.includes(state)),
      ...intrinsicContactSurvivors.filter(
        (state) =>
          !baselineRetained.includes(state) && !boundaryAnchorSurvivors.includes(state)
      ),
      ...paretoFrontierSurvivors.filter(
        (state) =>
          !baselineRetained.includes(state) &&
          !boundaryAnchorSurvivors.includes(state) &&
          !intrinsicContactSurvivors.includes(state)
      )
    ],
    layoutScorer
  )

  if (decisionTrace !== undefined) {
    const retainedStates = new Set(retained.map(({ state }) => state))
    const productionRetainedStates = new Set(baselineRetained.map(({ state }) => state))
    const protectedBoundaryStates = new Set(boundaryAnchorSurvivors.map(({ state }) => state))
    const protectedIntrinsicStates = new Set(
      intrinsicContactSurvivors.map(({ state }) => state)
    )
    const protectedParetoFrontierStates = new Set(
      paretoFrontierSurvivors.map(({ state }) => state)
    )
    const productionRanks = new Map(
      productionRanked.map(({ state }, index) => [state, index] as const)
    )
    const protectedBoundaryRanks = new Map(
      rankedProtectedBoundarySuccessors.map(({ state }, index) => [state, index] as const)
    )
    const protectedIntrinsicRanks = new Map(
      rankedProtectedIntrinsicSuccessors.map(({ state }, index) => [state, index] as const)
    )
    const protectedParetoFrontierRanks = new Map(
      rankedParetoFrontierSuccessors.map(({ state }, index) => [state, index] as const)
    )
    const incumbentRank =
      incumbent === undefined ? -1 : (productionRanks.get(incumbent.state) ?? -1)
    const incumbentDisplacedAlternative = incumbentRank >= beamWidth
    for (const [stateIndex, scoredState] of ranked.entries()) {
      const retainedState = retainedStates.has(scoredState.state)
      const retainedByProduction = productionRetainedStates.has(scoredState.state)
      const retainedOnlyByBoundaryProtection =
        !retainedByProduction && protectedBoundaryStates.has(scoredState.state)
      const retainedOnlyByIntrinsicProtection =
        !retainedByProduction &&
        !retainedOnlyByBoundaryProtection &&
        protectedIntrinsicStates.has(scoredState.state)
      const retainedOnlyByParetoFrontierProtection =
        !retainedByProduction &&
        !retainedOnlyByBoundaryProtection &&
        !retainedOnlyByIntrinsicProtection &&
        protectedParetoFrontierStates.has(scoredState.state)
      const productionRank = productionRanks.get(scoredState.state)
      const protectedBoundaryRank = protectedBoundaryRanks.get(scoredState.state)
      const protectedIntrinsicRank = protectedIntrinsicRanks.get(scoredState.state)
      const protectedParetoFrontierRank = protectedParetoFrontierRanks.get(scoredState.state)
      const protectedIncumbent =
        retainedByProduction &&
        incumbentDisplacedAlternative &&
        scoredState.state === incumbent?.state
      const displacedByIncumbent =
        !retainedState &&
        incumbentDisplacedAlternative &&
        productionRank !== undefined &&
        productionRank < beamWidth
      const traceRank = retainedOnlyByParetoFrontierProtection
        ? protectedParetoFrontierRank
        : retainedOnlyByIntrinsicProtection
          ? protectedIntrinsicRank
          : retainedOnlyByBoundaryProtection
            ? protectedBoundaryRank
            : (productionRank ??
              protectedBoundaryRank ??
              protectedIntrinsicRank ??
              protectedParetoFrontierRank)
      decisionTrace.emit(new IrregularDecisionTraceBeamSelection({
        decodeId: decisionTrace.decodeId,
        chromosomeId: decisionTrace.chromosomeId,
        decodeSource: decisionTrace.decodeSource,
        stepIndex,
        stateId: decisionTrace.stateIds.idFor(scoredState.key),
        rank: (traceRank ?? stateIndex) + 1,
        decision: retainedState ? 'retained' : 'pruned',
        reason: protectedIncumbent
          ? 'protected_incumbent'
          : retainedByProduction
            ? 'within_beam_width'
          : retainedOnlyByBoundaryProtection
            ? 'protected_boundary_anchor_survivor'
          : retainedOnlyByIntrinsicProtection
            ? 'protected_intrinsic_contact_survivor'
          : retainedOnlyByParetoFrontierProtection
            ? 'protected_pareto_frontier_survivor'
          : displacedByIncumbent
            ? 'displaced_by_protected_incumbent'
            : 'outside_beam_width'
      }))
    }
  }
  return {
    retained,
    productionSurvivors: baselineRetained,
    boundaryAnchorSurvivors,
    intrinsicContactSurvivors,
    paretoFrontierSurvivors
  }
}

function selectBoundaryAnchorSurvivor(
  ranked: ReadonlyArray<ScoredState>,
  retained: ReadonlyArray<ScoredState>,
  sheet: SheetSpec
): ScoredState | undefined {
  const retainedStates = new Set(retained.map(({ state }) => state))
  const anchorClassesByScore = new Map<string, Set<string>>()
  for (const { state, score } of retained) {
    const scoreKey = positionIndependentLayoutScoreKey(score)
    const anchorClass = sheetBoundaryAnchorClass(state, sheet)
    if (anchorClass === undefined) continue
    const classes = anchorClassesByScore.get(scoreKey)
    if (classes === undefined) {
      anchorClassesByScore.set(scoreKey, new Set([anchorClass]))
    } else {
      classes.add(anchorClass)
    }
  }

  for (const candidate of ranked) {
    if (retainedStates.has(candidate.state)) continue
    const scoreKey = positionIndependentLayoutScoreKey(candidate.score)
    const anchorClass = sheetBoundaryAnchorClass(candidate.state, sheet)
    if (anchorClass === undefined) continue
    const representedClasses = anchorClassesByScore.get(scoreKey)
    if (representedClasses !== undefined && !representedClasses.has(anchorClass)) return candidate
  }
  return undefined
}

function positionIndependentLayoutScoreKey(score: IrregularLayoutScore): string {
  const scaleAware = score.placementOrder.length > STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT
  return JSON.stringify([
    score.unplacedCount,
    score.dominantNearCompleteStructuralContactCount,
    scaleAware
      ? Math.floor(
          score.nearCompleteStructuralContactCount / STRUCTURAL_CONTACT_COUNT_BAND_WIDTH
        )
      : score.nearCompleteStructuralContactCount,
    score.collisionBoundsWorstNormalizedSheetConsumption,
    score.collisionBoundsNormalizedSpanSum,
    score.collisionBoundsAreaMm2,
    score.collisionBoundsSpanMm,
    score.occupiedHullWasteRatio,
    scaleAware ? score.nearCompleteStructuralContactCount : score.sharedCollisionBoundaryContactBand,
    score.sharedCollisionBoundaryContactUnits,
    score.sharedCollisionBoundaryLengthMm
  ])
}

function sheetBoundaryAnchorClass(state: IrregularBeamState, sheet: SheetSpec): string | undefined {
  const bounds = state.translatedCollisionBounds
  if (bounds === undefined) return undefined
  const minX = canonicalizeIrregularScoreMillimeters(bounds.minX)
  const minY = canonicalizeIrregularScoreMillimeters(bounds.minY)
  const maxX = canonicalizeIrregularScoreMillimeters(bounds.maxX)
  const maxY = canonicalizeIrregularScoreMillimeters(bounds.maxY)
  if (minX === undefined || minY === undefined || maxX === undefined || maxY === undefined) {
    return undefined
  }
  const anchors: string[] = []
  if (minY === 0) anchors.push('bottom')
  if (minX === 0) anchors.push('left')
  if (maxY === sheet.height) anchors.push('top')
  if (maxX === sheet.width) anchors.push('right')
  return anchors.length === 0 ? undefined : anchors.join('-')
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
    usedClusterMaxSideMm: score.usedClusterMaxSideMm,
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
