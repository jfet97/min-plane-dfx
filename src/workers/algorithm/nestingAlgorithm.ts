import type { Order } from 'effect'
import type { FreeRectangle, Placement, PreparedPiece, SheetSpec } from '@shared/domain/nesting.js'
import type { PieceId } from '@shared/domain/ids.js'

/**
 * Partial layout owned by the algorithm core.
 * This is the state compared by the beam order and later rendered as history.
 */
export interface NestingAlgorithmState {
  readonly placements: ReadonlyArray<Placement>
  readonly freeRectangles: ReadonlyArray<FreeRectangle>
  readonly remainingPieces: ReadonlyArray<PreparedPiece>
}

export namespace FreeRectangleOrder {
  /**
   * Inputs needed to rank free rectangles for one placement decision.
   * The chosen strategy can depend on the current state, piece, and orientation.
   */
  export interface Context {
    readonly state: NestingAlgorithmState
    readonly piece: PreparedPiece
    readonly rotated: boolean
  }

  /**
   * Strategy hook that returns the free-rectangle order for one decision point.
   * The wrapper owns how configured strategy ids become this function.
   */
  export type ForPiece = (context: Context) => Order.Order<FreeRectangle>
}

/**
 * Beam survivor order for partial states.
 * After expansion, this decides which states stay alive for the next piece.
 */
export type NestingStateOrder = Order.Order<NestingAlgorithmState>

/**
 * One legal placement candidate produced while expanding a state.
 * It carries enough data for history and scoring without exposing worker types.
 */
export interface NestingAlgorithmCandidate {
  readonly candidateId: string
  readonly state: NestingAlgorithmState
  readonly piece: PreparedPiece
  readonly freeRectangle: FreeRectangle
  readonly rotated: boolean
  readonly placement?: Placement
  readonly score?: ReadonlyArray<number>
}

/**
 * Free-rectangle split details produced by one committed placement.
 * The wrapper can translate this into history without owning split logic.
 */
export interface NestingAlgorithmFreeRectangleSplit {
  readonly before: FreeRectangle
  readonly after: ReadonlyArray<FreeRectangle>
  readonly pruned: ReadonlyArray<FreeRectangle>
}

/**
 * First event for a strategy run.
 * It gives the wrapper a concrete starting state for history.
 */
export interface InitialStateEvent {
  readonly type: 'initial_state'
  readonly state: NestingAlgorithmState
}

/**
 * Candidate-expansion event for one algorithm step.
 * It reports the current beam and the candidates considered for the next beam.
 */
export interface BeamStepEvent {
  readonly type: 'beam_step'
  readonly stepIndex: number
  readonly beam: ReadonlyArray<NestingAlgorithmState>
  readonly candidates: ReadonlyArray<NestingAlgorithmCandidate>
}

/**
 * Candidate scoring event.
 * It lets history explain why a candidate was ranked before selection.
 */
export interface CandidateRankedEvent {
  readonly type: 'candidate_ranked'
  readonly stepIndex: number
  readonly candidate: NestingAlgorithmCandidate
}

/**
 * Beam survivor event.
 * It records which partial state survived and at which beam rank.
 */
export interface StateSelectedEvent {
  readonly type: 'state_selected'
  readonly stepIndex: number
  readonly beamRank: number
  readonly state: NestingAlgorithmState
}

/**
 * Placement transition event.
 * It records the exact candidate that moved the algorithm between two states.
 */
export interface PlacementCommittedEvent {
  readonly type: 'placement_committed'
  readonly stepIndex: number
  readonly beamRank: number
  readonly previousState: NestingAlgorithmState
  readonly nextState: NestingAlgorithmState
  readonly candidate: NestingAlgorithmCandidate
}

/**
 * Free-rectangle mutation event.
 * It records split and pruning output for the committed placement.
 */
export interface FreeRectanglesSplitEvent {
  readonly type: 'free_rectangles_split'
  readonly stepIndex: number
  readonly beamRank: number
  readonly piece: PreparedPiece
  readonly split: NestingAlgorithmFreeRectangleSplit
}

/**
 * Final event for a strategy run.
 * It gives the wrapper the same outcome returned by the algorithm core.
 */
export interface AlgorithmCompletedEvent {
  readonly type: 'completed'
  readonly outcome: NestingAlgorithmOutcome
}

/**
 * Algorithm event stream consumed by the worker wrapper.
 * Events are synchronous and translated externally into persisted history.
 */
export type NestingAlgorithmEvent =
  | InitialStateEvent
  | BeamStepEvent
  | CandidateRankedEvent
  | StateSelectedEvent
  | PlacementCommittedEvent
  | FreeRectanglesSplitEvent
  | AlgorithmCompletedEvent

/**
 * Synchronous hooks exposed by the algorithm core.
 * The wrapper bridges these events to Effect queues, files, and worker sends.
 */
export interface NestingAlgorithmHooks {
  readonly onEvent?: (event: NestingAlgorithmEvent) => void
}

/**
 * Complete input for one strategy run of the algorithm core.
 * It contains domain data plus ordering hooks, but no worker/protocol concerns.
 */
export interface NestingAlgorithmInput {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<PreparedPiece>
  readonly freeRectangleOrder: FreeRectangleOrder.ForPiece
  readonly stateOrder: NestingStateOrder
  readonly hooks?: NestingAlgorithmHooks
}

/**
 * Minimal result returned by the algorithm core.
 * The worker wrapper turns this into protocol-facing result envelopes.
 */
export interface NestingAlgorithmOutcome {
  readonly sortedPieceIds: ReadonlyArray<PieceId>
  readonly placements: ReadonlyArray<Placement>
  readonly unplacedPieceIds: ReadonlyArray<PieceId>
}

/**
 * Algorithm-core boundary for the future placement implementation.
 *
 * The real algorithm will use `freeRectangleOrder` to rank legal free
 * rectangles for the current state/piece/orientation, and `stateOrder` to keep
 * the beam survivors. This stub only exposes that shape; it does not place,
 * split, rank, or score anything.
 */
export function runNestingAlgorithmStub(input: NestingAlgorithmInput): NestingAlgorithmOutcome {
  const initialState: NestingAlgorithmState = {
    placements: [],
    freeRectangles: [],
    remainingPieces: input.pieces
  }

  input.hooks?.onEvent?.({
    type: 'initial_state',
    state: initialState
  })

  const outcome = {
    sortedPieceIds: input.pieces.map((piece) => piece.id),
    placements: [],
    unplacedPieceIds: input.pieces.map((piece) => piece.id)
  }
  input.hooks?.onEvent?.({
    type: 'completed',
    outcome
  })

  return outcome
}
