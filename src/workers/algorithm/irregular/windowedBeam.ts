import { Effect, Order } from 'effect'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPlacedPiece,
  IrregularNestingSettings,
  IrregularPreparedPiece,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
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

export type IrregularWindowedBeamError =
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularPlacementScoringError
  | IrregularLayoutScoringError

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
}): Effect.Effect<
  IrregularWindowedBeamResult,
  IrregularWindowedBeamError,
  GeometryKernel | GeometrySettings | NfpIfpService | IrregularPlacementScorer | IrregularLayoutScorer
> {
  return Effect.gen(function* () {
    const settings = yield* GeometrySettings
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const placementScorer = yield* IrregularPlacementScorer
    const layoutScorer = yield* IrregularLayoutScorer

    let beam: ReadonlyArray<IrregularBeamState> = [IrregularBeamState.empty(input.pieces)]
    input.hooks?.onInitialState?.(beam[0] ?? IrregularBeamState.empty(input.pieces))
    let stepIndex = 0
    while (beam.some((state) => state.remainingPreparedPieces.length > 0)) {
      const successors: IrregularBeamState[] = []
      let candidateCount = 0

      for (const state of beam) {
        const eligibleCount = Math.min(
          settings.optimizer.orderWindow,
          state.remainingPreparedPieces.length
        )
        const eligiblePieces = state.remainingPreparedPieces.slice(0, eligibleCount)
        const legalSuccessors: IrregularBeamState[] = []

        const localCandidateLimit =
          settings.optimizer.orderWindow === 1 ? 1 : settings.optimizer.beamWidth
        for (const [pieceIndex, piece] of eligiblePieces.entries()) {
          const localCandidates = yield* collectLocalCandidates({
            sheet: input.sheet,
            settings,
            state,
            piece,
            geometryKernel,
            nfpIfpService,
            placementScorer
          })
          candidateCount += localCandidates.length
          const selected = selectLocalCandidates(
            localCandidates,
            placementScorer,
            localCandidateLimit
          )
          for (const candidate of selected) {
            legalSuccessors.push(applyPlacement(state, pieceIndex, piece, candidate))
          }
        }

        if (legalSuccessors.length === 0) {
          successors.push(markFirstRemainingUnplaced(state))
        } else {
          successors.push(...legalSuccessors)
        }
      }

      const scored = yield* scoreStates(successors, input.sheet, layoutScorer)
      beam = dedupeAndPrune(scored, settings.optimizer.beamWidth, layoutScorer)
      for (const [beamRank, state] of beam.entries()) {
        input.hooks?.onStateSelected?.({
          stepIndex,
          beamRank,
          state,
          candidateCount
        })
      }
      stepIndex += 1
    }

    const ranked = yield* scoreStates(beam, input.sheet, layoutScorer)
    const rankedStates = rankScoredStates(ranked, layoutScorer).map(({ state }) => state)
    const bestState = rankedStates[0]
    if (bestState === undefined) {
      return yield* Effect.die('windowed irregular beam produced no terminal state')
    }
    return { rankedStates, bestState }
  })
}

/** Positional decoder alias matching the strict decoder's public shape. */
export function decodeWindowedIrregularBeam(
  sheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  hooks?: IrregularWindowedBeamHooks
): Effect.Effect<
  IrregularWindowedBeamResult,
  IrregularWindowedBeamError,
  GeometryKernel | GeometrySettings | NfpIfpService | IrregularPlacementScorer | IrregularLayoutScorer
> {
  return runWindowedIrregularBeam({
    sheet,
    pieces,
    ...(hooks !== undefined ? { hooks } : {})
  })
}

function collectLocalCandidates(input: {
  readonly sheet: SheetSpec
  readonly settings: IrregularNestingSettings
  readonly state: IrregularBeamState
  readonly piece: IrregularPreparedPiece
  readonly geometryKernel: GeometryKernel.Service
  readonly nfpIfpService: NfpIfpService
  readonly placementScorer: IrregularPlacementScorer.Service
}): Effect.Effect<
  ReadonlyArray<LocalCandidate>,
  IrregularNestingNotImplementedError | IrregularGeometryInputError | IrregularPlacementScoringError
> {
  return Effect.gen(function* () {
    const candidates: LocalCandidate[] = []
    for (const transform of input.piece.transforms.toSorted(transformOrder)) {
      const moving = yield* input.geometryKernel.transformCollisionGeometry({
        geometry: input.piece.collisionGeometry,
        transform
      })
      const legalCandidates = yield* input.nfpIfpService.generatePlacementCandidates({
        sheet: input.sheet,
        placed: input.state.placedCollisionGeometries,
        moving,
        settings: input.settings
      })
      for (const candidate of legalCandidates) {
        const score = yield* input.placementScorer.scoreCandidate({
          sheet: input.sheet,
          placed: input.state.placedCollisionGeometries,
          moving,
          candidate
        })
        candidates.push({ candidate, moving, score })
      }
    }
    return candidates
  })
}

function selectLocalCandidates(
  candidates: ReadonlyArray<LocalCandidate>,
  placementScorer: IrregularPlacementScorer.Service,
  maximumCount: number
): ReadonlyArray<LocalCandidate> {
  const candidateOrder = Order.combineAll<LocalCandidate>([
    Order.make((first, second) => placementScorer.compare(first.score, second.score)),
    Order.mapInput(Order.String, (candidate) => localCandidateKey(candidate))
  ])
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
  return new IrregularBeamState({
    remainingPreparedPieces: removeAt(state.remainingPreparedPieces, pieceIndex),
    placedCollisionGeometries: [...state.placedCollisionGeometries, placed],
    unplacedPieceIds: state.unplacedPieceIds,
    placementOrder: [...state.placementOrder, pieceId]
  })
}

function markFirstRemainingUnplaced(state: IrregularBeamState): IrregularBeamState {
  const first = state.remainingPreparedPieces[0]
  if (first === undefined) return state
  return new IrregularBeamState({
    remainingPreparedPieces: state.remainingPreparedPieces.slice(1),
    placedCollisionGeometries: state.placedCollisionGeometries,
    unplacedPieceIds: [...state.unplacedPieceIds, preparedPieceId(first)],
    placementOrder: state.placementOrder
  })
}

function removeAt<A>(values: ReadonlyArray<A>, index: number): ReadonlyArray<A> {
  return [...values.slice(0, index), ...values.slice(index + 1)]
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function scoreStates(
  states: ReadonlyArray<IrregularBeamState>,
  sheet: SheetSpec,
  layoutScorer: IrregularLayoutScorer.Service
): Effect.Effect<ReadonlyArray<ScoredState>, IrregularLayoutScoringError | IrregularGeometryInputError | IrregularNestingNotImplementedError> {
  return Effect.forEach(states, (state) =>
    layoutScorer
      .scoreState({ sheet, state })
      .pipe(Effect.map((score) => ({ state, score, key: beamStateKey(state) })))
  )
}

function dedupeAndPrune(
  states: ReadonlyArray<ScoredState>,
  beamWidth: number,
  layoutScorer: IrregularLayoutScorer.Service
): ReadonlyArray<IrregularBeamState> {
  const stateOrder = makeStateOrder(layoutScorer)
  const deduped = new Map<string, ScoredState>()
  for (const current of states) {
    const previous = deduped.get(current.key)
    if (previous === undefined || stateOrder(current, previous) < 0) {
      deduped.set(current.key, current)
    }
  }
  return rankScoredStates([...deduped.values()], layoutScorer)
    .slice(0, beamWidth)
    .map(({ state }) => state)
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
  const placed = state.placedCollisionGeometries
    .map((placedPiece) => {
      const placement = placedPiece.placement
      const transform = placement.transform
      const pieceId = placement.pieceId ?? placement.sourcePieceId
      const polygon = placedPiece.collisionGeometry.polygon.points
        .map((point) => `${point.x}:${point.y}`)
        .join(',')
      return `${pieceId}:${placement.sourcePieceId}:${transform.translateX}:${transform.translateY}:${transform.rotationDeg}:${Number(transform.mirrored)}:${polygon}`
    })
    .toSorted(Order.String)
    .join('|')
  const remaining = state.remainingPreparedPieces.map(preparedPieceId).join('|')
  const unplaced = [...state.unplacedPieceIds].toSorted(Order.String).join('|')
  return `${placed}::${remaining}::${unplaced}`
}
