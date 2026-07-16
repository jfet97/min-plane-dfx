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

/** The terminal states retained by one deterministic irregular beam run. */
export interface IrregularWindowedBeamResult {
  readonly rankedStates: ReadonlyArray<IrregularBeamState>
  readonly bestState: IrregularBeamState
  readonly bestScore: IrregularLayoutScore
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
}

interface ScoredState {
  readonly state: IrregularBeamState
  readonly score: IrregularLayoutScore
  readonly key: string
}

interface KeyedState {
  readonly state: IrregularBeamState
  readonly key: string
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

    let beam: ReadonlyArray<IrregularBeamState> = [IrregularBeamState.empty(input.pieces)]
    let scoredBeam: ReadonlyArray<ScoredState> | undefined
    const candidateCounts: number[] = []
    const controlState: ControlState = { checkpointsSinceYield: 0 }
    while (beam.some((state) => state.remainingPreparedPieces.length > 0)) {
      yield* controlCheckpoint(input.control, controlState)
      const successors: IrregularBeamState[] = []
      let candidateCount = 0

      for (const state of beam) {
        yield* controlCheckpoint(input.control, controlState)
        const eligibleCount = Math.min(
          settings.optimizer.orderWindow,
          state.remainingPreparedPieces.length
        )
        const eligiblePieces = state.remainingPreparedPieces.slice(0, eligibleCount)
        const legalSuccessors: IrregularBeamState[] = []

        const localCandidateLimit =
          settings.optimizer.localCandidateFanout ?? settings.optimizer.beamWidth
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
            ...(input.control !== undefined ? { control: input.control } : {}),
            ...(input.options !== undefined ? { options: input.options } : {})
          })
          candidateCount += localCandidates.length
          const selected = selectLocalCandidates(
            localCandidates,
            placementScorer,
            localCandidateLimit,
            input.options?.transformPreferences?.get(preparedPieceId(piece))
          )
          for (const candidate of selected) {
            yield* controlCheckpoint(input.control, controlState)
            legalSuccessors.push(applyPlacement(state, pieceIndex, piece, candidate))
          }
        }

        if (legalSuccessors.length === 0) {
          successors.push(markFirstRemainingUnplaced(state))
        } else {
          successors.push(...legalSuccessors)
        }
      }

      const uniqueSuccessors = dedupeRawSuccessors(successors)
      const scored = yield* scoreStates(
        uniqueSuccessors,
        input.sheet,
        layoutScorer,
        input.control,
        controlState
      )
      scoredBeam = pruneScoredStates(scored, settings.optimizer.beamWidth, layoutScorer)
      beam = scoredBeam.map(({ state }) => state)
      candidateCounts.push(candidateCount)
      input.instrumentation?.onStepCompleted?.({ candidateCount })
    }

    const ranked = rankScoredStates(
      scoredBeam ??
        (yield* scoreStates(
          beam.map((state) => ({ state, key: beamStateKey(state) })),
          input.sheet,
          layoutScorer,
          input.control,
          controlState
        )),
      layoutScorer
    )
    yield* controlCheckpoint(input.control, controlState)
    const best = ranked[0]
    if (best === undefined) {
      return yield* Effect.die('windowed irregular beam produced no terminal state')
    }
    emitWinningPath(input.hooks, best.state, candidateCounts)
    return {
      rankedStates: ranked.map(({ state }) => state),
      bestState: best.state,
      bestScore: best.score
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
  instrumentation?: IrregularWindowedBeamInstrumentation
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
    ...(instrumentation !== undefined ? { instrumentation } : {})
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
  preferredTransformIndex: number | undefined
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
  return candidates.toSorted(candidateOrder).slice(0, maximumCount)
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
  controlState: ControlState
): Effect.Effect<
  ReadonlyArray<ScoredState>,
  | IrregularLayoutScoringError
  | IrregularGeometryInputError
  | IrregularNestingNotImplementedError
  | IrregularWindowedBeamAbortedError
> {
  return Effect.gen(function* () {
    const scored: ScoredState[] = []
    for (const { state, key } of states) {
      yield* controlCheckpoint(control, controlState)
      const score = yield* layoutScorer.scoreState({ sheet, state })
      scored.push({ state, score, key })
      yield* controlCheckpoint(control, controlState)
    }
    return scored
  })
}

function dedupeRawSuccessors(states: ReadonlyArray<IrregularBeamState>): ReadonlyArray<KeyedState> {
  const deduped = new Map<string, KeyedState>()
  for (const state of states) {
    const current = { state, key: beamStateKey(state) }
    const previous = deduped.get(current.key)
    if (previous === undefined || compareRepresentativeStates(current, previous) < 0) {
      deduped.set(current.key, current)
    }
  }
  return [...deduped.values()]
}

function pruneScoredStates(
  states: ReadonlyArray<ScoredState>,
  beamWidth: number,
  layoutScorer: IrregularLayoutScorer.Service
): ReadonlyArray<ScoredState> {
  return rankScoredStates(states, layoutScorer).slice(0, beamWidth)
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

function localCandidateKey(candidate: LocalCandidate): string {
  const transform = candidate.candidate.transform
  const points = candidate.moving.polygon.points.map((point) => `${point.x}:${point.y}`).join(',')
  return `${candidate.candidate.pieceId}:${candidate.candidate.point.x}:${candidate.candidate.point.y}:${transform.index}:${transform.rotationDeg}:${Number(transform.mirrored)}:${transform.reason}:${points}`
}

function beamStateKey(state: IrregularBeamState): string {
  const remaining = state.remainingPreparedPieces.map(preparedPieceId).join('|')
  const unplaced = [...state.unplacedPieceIds].toSorted(Order.String).join('|')
  return `${state.canonicalOccupiedGeometryKey}::${remaining}::${unplaced}`
}
