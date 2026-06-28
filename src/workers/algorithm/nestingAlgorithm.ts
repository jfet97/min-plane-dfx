import type { Order } from 'effect'
import type { FreeRectangle, Placement, PreparedPiece, SheetSpec } from '@shared/domain/nesting.js'
import type { PieceId } from '@shared/domain/ids.js'
import { initialState } from './beam/seed.js'
import type { NestingAlgorithmState, NestingBeamState } from './beam/state.js'
export { K } from './beam/state.js'
export type { NestingAlgorithmState, NestingBeamState } from './beam/state.js'
export { initialState } from './beam/seed.js'

// free rectangles considered per state/piece/orientation at most
export const freeRectFanout = 2

/**
 * Strategy hook that returns the free-rectangle order for one decision point.
 * The wrapper owns how configured strategy ids become this function.
 */
export type FreeRectangleOrder = (context: {
  state: NestingBeamState
  piece: PreparedPiece
  rotated: boolean
}) => Order.Order<FreeRectangle>

/**
 * Beam survivor order for partial layout states.
 * After expansion, this decides which states stay alive for the next piece.
 */
export type NestingStateOrder = () => Order.Order<NestingBeamState>

/**
 * One legal placement candidate produced while expanding a state.
 * It always includes the concrete placement it would commit.
 */
export interface NestingAlgorithmCandidate {
  readonly candidateId: string
  readonly state: NestingBeamState
  readonly piece: PreparedPiece
  readonly freeRectangle: FreeRectangle
  readonly rotated: boolean
  readonly placement: Placement
}

/**
 * Ranked view of a generated candidate.
 * Scoring is a separate phase, so unranked candidates do not carry score data.
 */
export interface NestingAlgorithmScoredCandidate {
  readonly candidate: NestingAlgorithmCandidate
  readonly score: ReadonlyArray<number>
}

/**
 * Algorithm events emitted synchronously by the core.
 * The worker wrapper translates these events into persisted history frames.
 */
export namespace NestingAlgorithmEvent {
  /**
   * First event for a strategy run.
   * It gives the wrapper a concrete starting state for history.
   */
  export interface InitialState {
    readonly type: 'initial_state'
    readonly state: NestingAlgorithmState
  }

  /**
   * Candidate-expansion event for one algorithm step.
   * It reports the current beam and the candidates considered for the next beam.
   */
  export interface BeamStep {
    readonly type: 'beam_step'
    readonly stepIndex: number
    readonly state: NestingAlgorithmState
    readonly candidates: ReadonlyArray<NestingAlgorithmCandidate>
  }

  /**
   * Candidate scoring event.
   * It lets history explain why a candidate was ranked before selection.
   */
  export interface CandidateRanked {
    readonly type: 'candidate_ranked'
    readonly stepIndex: number
    readonly scoredCandidate: NestingAlgorithmScoredCandidate
  }

  /**
   * Beam survivor event.
   * It records which partial state survived and at which beam rank.
   */
  export interface StateSelected {
    readonly type: 'state_selected'
    readonly stepIndex: number
    readonly beamRank: number
    readonly state: NestingBeamState
  }

  /**
   * Placement transition event.
   * It records the exact candidate that moved the algorithm between two states.
   */
  export interface PlacementCommitted {
    readonly type: 'placement_committed'
    readonly stepIndex: number
    readonly beamRank: number
    readonly previousState: NestingBeamState
    readonly nextState: NestingBeamState
    readonly candidate: NestingAlgorithmCandidate
  }

  /**
   * Free-rectangle mutation event.
   * It records split and pruning output for the committed placement.
   */
  export interface FreeRectanglesSplit {
    readonly type: 'free_rectangles_split'
    readonly stepIndex: number
    readonly beamRank: number
    readonly piece: PreparedPiece
    readonly split: {
      readonly before: FreeRectangle
      readonly after: ReadonlyArray<FreeRectangle>
      readonly pruned: ReadonlyArray<FreeRectangle>
    }
  }

  /**
   * Final event for a strategy run.
   * It gives the wrapper the same outcome returned by the algorithm core.
   */
  export interface Completed {
    readonly type: 'completed'
    readonly outcome: {
      readonly sortedPieceIds: ReadonlyArray<PieceId>
      readonly placements: ReadonlyArray<Placement>
      readonly unplacedPieceIds: ReadonlyArray<PieceId>
    }
  }

  /**
   * Union of every algorithm event state.
   * Consumers should switch on `type` and translate only the events they need.
   */
  export type Event =
    | InitialState
    | BeamStep
    | CandidateRanked
    | StateSelected
    | PlacementCommitted
    | FreeRectanglesSplit
    | Completed
}

/**
 * Algorithm-core boundary for the future placement implementation.
 *
 * The real algorithm will use `freeRectangleOrder` to rank legal free
 * rectangles for the current state/piece/orientation, and `stateOrder` to keep
 * the beam survivors. This stub only exposes that shape; it does not place,
 * split, rank, or score anything.
 */
export function runMaxRectsBeamSearch(input: {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<PreparedPiece>
  readonly freeRectangleOrder: FreeRectangleOrder
  readonly stateOrder: NestingStateOrder
  // synchronous hooks
  readonly hooks?: {
    readonly onEvent?: (event: NestingAlgorithmEvent.Event) => void
  }
}) {
  const state = initialState(input)

  input.hooks?.onEvent?.({
    type: 'initial_state',
    state: state
  })

  for (const [stepIndex, piece] of input.pieces.entries()) {
    console.log(`Processing piece ${stepIndex + 1}/${input.pieces.length} (id=${piece.id})`)
  }

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
