import { randomUUID } from 'node:crypto'
import type { Order } from 'effect'
import type { FreeRectangle, Placement, PreparedPiece, SheetSpec } from '@shared/domain/nesting.js'
import type { PieceId } from '@shared/domain/ids.js'
import { initialState } from './beam/seed.js'
import type { NestingAlgorithmState, NestingBeamState } from './beam/state.js'
import { makeBottomLeftPlacement } from './maxRects/placements.js'
import { placementFitsFreeRectangle } from './maxRects/freeRectangles.js'
export { K } from './beam/state.js'
export type { NestingAlgorithmState, NestingBeamState } from './beam/state.js'
export { initialState } from './beam/seed.js'

// candidate placements retained per state/piece/strategy at most
export const freeRectFanout = 2

/**
 * Strategy hook that returns the candidate placement order for one decision point.
 * The wrapper owns how configured strategy ids become this function.
 */
export type CandidateOrder = (context: {
  sheet: SheetSpec
}) => Order.Order<NestingAlgorithmCandidate>

export type CandidateOrders = readonly [CandidateOrder, ...CandidateOrder[]]

/**
 * Beam survivor order for partial layout states.
 * After expansion, this decides which states stay alive for the next piece.
 */
export type NestingStateOrder = () => Order.Order<NestingBeamState>

/**
 * One legal placement candidate produced while expanding a state.
 * It always includes the concrete placement it would commit.
 */
export class NestingAlgorithmCandidate {
  readonly candidateId: string
  readonly state: NestingBeamState
  readonly piece: PreparedPiece
  readonly freeRectangle: FreeRectangle
  readonly rotated: boolean
  readonly placement: Placement

  constructor(input: {
    readonly state: NestingBeamState
    readonly piece: PreparedPiece
    readonly freeRectangle: FreeRectangle
    readonly rotated: boolean
    readonly placement: Placement
  }) {
    this.candidateId = randomUUID()
    this.state = input.state
    this.piece = input.piece
    this.freeRectangle = input.freeRectangle
    this.rotated = input.rotated
    this.placement = input.placement
  }
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
 * The real algorithm will use each `candidateOrder` entry to rank legal
 * placement candidates for the current state/piece, and `stateOrder` to keep
 * the beam survivors. This stub only exposes that shape; it does not commit
 * placements, split next states, or score real results.
 */
export function runMaxRectsBeamSearch(input: {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<PreparedPiece>
  readonly beamWidth: number
  readonly candidateOrder: CandidateOrders
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

  for (const s of [state.top, ...state.alternatives]) {
    const piece = s.remainingPieces[0]

    if (piece === undefined) {
      // this branch has no more pieces to place
      continue
    }

    for (const candidateOrder of input.candidateOrder) {
      const candidates: NestingAlgorithmCandidate[] = []
      const order = candidateOrder({ sheet: input.sheet })

      for (const rotated of piece.allowRotation ? [false, true] : [false]) {
        for (const freeRectangle of s.freeRectangles) {
          const placement = makeBottomLeftPlacement(freeRectangle, piece, rotated)

          if (!placementFitsFreeRectangle(freeRectangle, placement)) {
            continue
          }

          candidates.push(
            new NestingAlgorithmCandidate({
              state: s,
              piece,
              freeRectangle,
              rotated,
              placement
            })
          )
        }
      }

      const selectedCandidates = candidates.toSorted(order).slice(0, freeRectFanout)
      if (selectedCandidates.length === 0) {
        continue
      }
    }
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
