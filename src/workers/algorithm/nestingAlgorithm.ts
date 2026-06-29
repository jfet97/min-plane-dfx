import type { Order } from 'effect'
import type { Placement, PreparedPiece, SheetSpec } from '@shared/domain/nesting.js'
import type { PieceId } from '@shared/domain/ids.js'
import {
  applyCandidate,
  NestingAlgorithmCandidate,
  type AppliedCandidate
} from './beam/candidates.js'
import { initialState } from './beam/seed.js'
import {
  beamFromMembers,
  beamMembers,
  isBeamComplete,
  markNextPieceUnplaced,
  type NestingAlgorithmState,
  type NestingBeamState
} from './beam/state.js'
import { makeBottomLeftPlacement } from './maxRects/placements.js'
import { FreeRectangles } from './maxRects/freeRectangles.js'
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

export { NestingAlgorithmCandidate } from './beam/candidates.js'

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
   * Placement application event.
   * It records the committed candidate plus the resulting split/prune data.
   */
  export interface PlacementApplied {
    readonly type: 'placement_applied'
    readonly stepIndex: number
    readonly beamRank: number
    readonly applied: AppliedCandidate
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
    | PlacementApplied
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
  let state = initialState(input)

  input.hooks?.onEvent?.({
    type: 'initial_state',
    state: state
  })

  let stepIndex = 0

  while (!isBeamComplete(state)) {
    // collect every branch produced by expanding the current retained beam
    const successorStates: NestingBeamState[] = []
    // aggregate generated candidates for the step-level history event
    const stepCandidates: NestingAlgorithmCandidate[] = []

    for (const [beamRank, s] of beamMembers(state).entries()) {
      const piece = s.remainingPieces[0]

      if (piece === undefined) {
        // this branch is terminal: carry it unchanged
        successorStates.push(s)
        continue
      }

      // tracks whether this branch placed its next piece through any strategy
      let producedSuccessor = false

      for (const candidateOrder of input.candidateOrder) {
        const candidates: NestingAlgorithmCandidate[] = []
        const order = candidateOrder({ sheet: input.sheet })

        // normal and rotated placements compete in one candidate pool
        for (const rotated of piece.allowRotation ? [false, true] : [false]) {
          for (const freeRectangle of s.freeRectangles) {
            const placement = makeBottomLeftPlacement(freeRectangle, piece, rotated)

            if (!FreeRectangles.doesPlacementFit(freeRectangle, placement)) {
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
        stepCandidates.push(...candidates)

        // fanout limits committed successors, not the free rectangles scanned
        const selectedCandidates = candidates.toSorted(order).slice(0, freeRectFanout)
        if (selectedCandidates.length > 0) {
          producedSuccessor = true
          for (const candidate of selectedCandidates) {
            const applied = applyCandidate(candidate)
            successorStates.push(applied.state)
            input.hooks?.onEvent?.({
              type: 'placement_applied',
              stepIndex,
              beamRank,
              applied
            })
          }
        }
      }

      if (!producedSuccessor) {
        // no legal placement is still progress: reject this piece and keep the branch alive
        successorStates.push(markNextPieceUnplaced(s))
      }
    }

    input.hooks?.onEvent?.({
      type: 'beam_step',
      stepIndex,
      state,
      candidates: stepCandidates
    })

    // all generated branches compete globally; only the best beamWidth survive
    const nextBeamMembers = successorStates.toSorted(input.stateOrder()).slice(0, input.beamWidth)

    state = beamFromMembers(nextBeamMembers)
    for (const [beamRank, member] of nextBeamMembers.entries()) {
      input.hooks?.onEvent?.({
        type: 'state_selected',
        stepIndex,
        beamRank,
        state: member
      })
    }
    stepIndex++
  }

  // sortedPieceIds is the attempted order, including pieces that ended up unplaced
  const outcome = {
    sortedPieceIds: input.pieces.map((piece) => piece.id),
    placements: state.top.placements,
    unplacedPieceIds: state.top.unplacedPieces.map((piece) => piece.id)
  }

  input.hooks?.onEvent?.({
    type: 'completed',
    outcome
  })

  return outcome
}
