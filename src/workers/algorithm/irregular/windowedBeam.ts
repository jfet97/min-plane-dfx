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
  IrregularLayoutScoringError
} from './irregularLayoutScorer.js'
import { IrregularBeamState } from './irregularBeamState.js'
import {
  IrregularDecisionTraceBeamSelection,
  IrregularDecisionTraceBeamStepCompleted,
  IrregularDecisionTraceBeamStepStarted,
  IrregularDecisionTraceDecodeStarted,
  IrregularDecisionTraceDecodeWinner,
  IrregularDecisionTraceEligiblePieces,
  IrregularDecisionTraceLayoutScore,
  IrregularDecisionTraceLocalCandidateScored,
  IrregularDecisionTraceLocalCandidateSelection,
  IrregularDecisionTraceLocalScore,
  IrregularDecisionTraceParentState,
  IrregularDecisionTracePoint,
  IrregularDecisionTraceSearchSettings,
  IrregularDecisionTraceSheet,
  IrregularDecisionTraceState,
  IrregularDecisionTraceSuccessorDeduplication,
  IrregularDecisionTraceSuccessorLayoutScored,
  IrregularDecisionTraceTransform,
  IrregularDecisionTraceTransformCandidatesGenerated,
  IrregularDecisionTraceTransformPreference
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
 * score. An aborted decode never returns its in-progress beam; the portfolio
 * may only retain a result returned after the complete terminal state was
 * scored.
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
  readonly traceCandidateId: string
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
 * branch considers the configured prefix of its queue, then retains a bounded
 * deterministic subset of each selected piece's real legal local candidates.
 * The layout scorer ranks the combined successor states for beam retention.
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
    const protectIncumbent = settings.optimizer.beamWidth > 1
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
        const parentStateId = beamStateKey(state)
        decisionTrace?.emit(new IrregularDecisionTraceParentState({
          decodeId: decisionTrace.decodeId,
          chromosomeId: decisionTrace.chromosomeId,
          decodeSource: decisionTrace.decodeSource,
          stepIndex,
          parentRank: parentIndex + 1,
          incumbent: isIncumbent,
          state: decisionTraceState(state)
        }))
        const eligibleCount = Math.min(
          settings.optimizer.orderWindow,
          state.remainingPreparedPieces.length
        )
        const eligiblePieces = state.remainingPreparedPieces.slice(0, eligibleCount)
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

      const uniqueSuccessors = dedupeRawSuccessors(successors, decisionTrace, stepIndex)
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
      scoredBeam = pruneScoredStates(
        scored,
        settings.optimizer.beamWidth,
        layoutScorer,
        nextIncumbent,
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
          beam.map((state) => ({ state, key: beamStateKey(state), isIncumbent: false })),
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
    const best = ranked[0]
    if (best === undefined) {
      return yield* Effect.die('windowed irregular beam produced no terminal state')
    }
    emitWinningPath(input.hooks, best.state, candidateCounts)
    decisionTrace?.emit(new IrregularDecisionTraceDecodeWinner({
      decodeId: decisionTrace.decodeId,
      chromosomeId: decisionTrace.chromosomeId,
      decodeSource: decisionTrace.decodeSource,
      state: decisionTraceState(best.state),
      score: decisionTraceLayoutScore(best.score)
    }))
    return {
      rankedStates: ranked.map(({ state }) => state),
      bestState: best.state,
      bestScore: best.score,
      candidateCounts
    }
  })
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
        settings: input.settings
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
        const traceCandidateId = `${localCandidateKey({ candidate, moving })}::${candidates.length}`
        candidates.push({ candidate, moving, score, traceCandidateId })
        input.decisionTrace?.emit(new IrregularDecisionTraceLocalCandidateScored({
          decodeId: input.decisionTrace.decodeId,
          chromosomeId: input.decisionTrace.chromosomeId,
          decodeSource: input.decisionTrace.decodeSource,
          stepIndex: input.stepIndex,
          parentStateId: input.parentStateId,
          pieceId: preparedPieceId(input.piece),
          candidateId: traceCandidateId,
          point: new IrregularDecisionTracePoint({ x: candidate.point.x, y: candidate.point.y }),
          transform: decisionTraceTransform(candidate.transform),
          policyId: score.policyId,
          score: decisionTraceLocalScore(score)
        }))
        yield* controlCheckpoint(input.control, input.controlState)
      }
    }
    return candidates
  })
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
  const rankedCandidates = candidates.toSorted(candidateOrder)
  const first = rankedCandidates[0]
  let selected: ReadonlyArray<LocalCandidate>
  let compactnessReserved: LocalCandidate | undefined
  if (
    maximumCount === 1 ||
    first?.score.policyId !== EDGE_CONTACT_THEN_BALANCED_COMPACTNESS_POLICY_ID
  ) {
    selected = rankedCandidates.slice(0, maximumCount)
  } else {
    const compactnessWinner = candidates.toSorted(
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

  if (decisionTrace !== undefined) {
    const selectedCandidates = new Set(selected)
    for (const [candidateIndex, candidate] of rankedCandidates.entries()) {
      const isSelected = selectedCandidates.has(candidate)
      const displacedByReservation =
        !isSelected && compactnessReserved !== undefined && candidateIndex < maximumCount
      decisionTrace.emit(new IrregularDecisionTraceLocalCandidateSelection({
        decodeId: decisionTrace.decodeId,
        chromosomeId: decisionTrace.chromosomeId,
        decodeSource: decisionTrace.decodeSource,
        stepIndex,
        parentStateId,
        pieceId,
        candidateId: candidate.traceCandidateId,
        rank: candidateIndex + 1,
        decision: isSelected ? 'selected' : 'rejected',
        reason:
          candidate === compactnessReserved
            ? 'compactness_alternative_reserved'
            : displacedByReservation
              ? 'displaced_by_compactness_reservation'
              : isSelected
                ? 'within_local_candidate_fanout'
                : 'outside_local_candidate_fanout'
      }))
    }
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
  candidateCounts: ReadonlyArray<number>
): void {
  if (hooks === undefined) return
  const path = winningStatePath(bestState)
  const initialState = path[0]
  if (initialState !== undefined) hooks.onInitialState?.(initialState)
  for (let index = 1; index < path.length; index += 1) {
    const state = path[index]
    if (state === undefined) continue
    hooks.onStateSelected?.({
      stepIndex: index - 1,
      beamRank: 0,
      state,
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
        state: decisionTraceState(state),
        score: decisionTraceLayoutScore(score)
      }))
      yield* controlCheckpoint(control, controlState)
    }
    return scored
  })
}

function dedupeRawSuccessors(
  states: ReadonlyArray<TaggedSuccessor>,
  decisionTrace: ActiveDecisionTrace | undefined,
  stepIndex: number
): ReadonlyArray<KeyedState> {
  const deduped = new Map<string, KeyedState>()
  const countsByKey = new Map<string, number>()
  for (const { state, isIncumbent } of states) {
    const current = { state, key: beamStateKey(state), isIncumbent }
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
      const key = beamStateKey(state)
      const winner = deduped.get(key)
      const kept = winner?.state === state && winner.isIncumbent === isIncumbent
      decisionTrace.emit(new IrregularDecisionTraceSuccessorDeduplication({
        decodeId: decisionTrace.decodeId,
        chromosomeId: decisionTrace.chromosomeId,
        decodeSource: decisionTrace.decodeSource,
        stepIndex,
        successorStateId: key,
        deduplicationKey: key,
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
  decisionTrace: ActiveDecisionTrace | undefined = undefined,
  stepIndex = 0
): ReadonlyArray<ScoredState> {
  const ranked = rankScoredStates(states, layoutScorer)
  const retained =
    beamWidth <= 1 || incumbent === undefined
      ? ranked.slice(0, beamWidth)
      : rankScoredStates(
          [
            incumbent,
            ...ranked
              .filter(({ state }) => state !== incumbent.state)
              .slice(0, beamWidth - 1)
          ],
          layoutScorer
        )

  if (decisionTrace !== undefined) {
    const retainedStates = new Set(retained.map(({ state }) => state))
    const incumbentRank = ranked.findIndex(({ state }) => state === incumbent?.state)
    const incumbentDisplacedAlternative = incumbentRank >= beamWidth
    for (const [stateIndex, scoredState] of ranked.entries()) {
      const retainedState = retainedStates.has(scoredState.state)
      const protectedIncumbent =
        retainedState && incumbentDisplacedAlternative && scoredState.state === incumbent?.state
      const displacedByIncumbent =
        !retainedState && incumbentDisplacedAlternative && stateIndex < beamWidth
      decisionTrace.emit(new IrregularDecisionTraceBeamSelection({
        decodeId: decisionTrace.decodeId,
        chromosomeId: decisionTrace.chromosomeId,
        decodeSource: decisionTrace.decodeSource,
        stepIndex,
        stateId: scoredState.key,
        rank: stateIndex + 1,
        decision: retainedState ? 'retained' : 'pruned',
        reason: protectedIncumbent
          ? 'protected_incumbent'
          : displacedByIncumbent
            ? 'displaced_by_protected_incumbent'
            : retainedState
              ? 'within_beam_width'
              : 'outside_beam_width'
      }))
    }
  }
  return retained
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

function beamStateKey(state: IrregularBeamState): string {
  const remaining = state.remainingPreparedPieces.map(preparedPieceId).join('|')
  const unplaced = [...state.unplacedPieceIds].toSorted(Order.String).join('|')
  return `${state.canonicalOccupiedGeometryKey}::${remaining}::${unplaced}`
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
    decodeSource: identity?.decodeSource ?? 'direct'
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

function decisionTraceState(state: IrregularBeamState): IrregularDecisionTraceState {
  return new IrregularDecisionTraceState({
    stateId: beamStateKey(state),
    placementOrder: state.placementOrder,
    remainingPieceIds: state.remainingPreparedPieces.map(preparedPieceId),
    unplacedPieceIds: state.unplacedPieceIds
  })
}
