import type { FreeRectangle, Placement, PreparedPiece } from '@shared/domain/nesting.js'

const minimumK = 5

// retained beam width from selected placement-order count
export function K(selectedStrategyCount: number): number {
  return Math.max(minimumK, selectedStrategyCount * 2)
}

/**
 * One partial layout kept inside the beam.
 * This is the unit compared by the state order and rendered as one history rank.
 */
export class NestingBeamState {
  readonly placements: ReadonlyArray<Placement>
  readonly freeRectangles: ReadonlyArray<FreeRectangle>
  /** Pieces still scheduled for future placement attempts, in original order. */
  readonly remainingPieces: ReadonlyArray<PreparedPiece>
  /** Pieces already rejected by this beam state because they did not fit. */
  readonly unplacedPieces: ReadonlyArray<PreparedPiece>

  constructor(input: {
    readonly placements: ReadonlyArray<Placement>
    readonly freeRectangles: ReadonlyArray<FreeRectangle>
    readonly remainingPieces: ReadonlyArray<PreparedPiece>
    readonly unplacedPieces: ReadonlyArray<PreparedPiece>
  }) {
    this.placements = input.placements
    this.freeRectangles = input.freeRectangles
    this.remainingPieces = input.remainingPieces
    this.unplacedPieces = input.unplacedPieces
  }
}

/**
 * Ranked beam container for one algorithm step.
 * `top` is rank 0; `alternatives` contains the remaining retained states.
 */
export interface NestingAlgorithmState {
  readonly top: NestingBeamState
  readonly alternatives: ReadonlyArray<NestingBeamState>
}

/**
 * Flattens the ranked beam container into rank order.
 * The top state is always first, followed by retained alternatives.
 */
export function beamMembers(state: NestingAlgorithmState): ReadonlyArray<NestingBeamState> {
  return [state.top, ...state.alternatives]
}

/**
 * Rebuilds the ranked beam container from already-ranked members.
 * An empty beam is invalid: failed placements must still produce unplaced-piece
 * successors instead of dropping every branch.
 */
export function beamFromMembers(
  members: ReadonlyArray<NestingBeamState>
): NestingAlgorithmState {
  const top = members[0]
  if (top === undefined) {
    throw new Error('Cannot build a beam from zero states')
  }

  return {
    top,
    alternatives: members.slice(1)
  }
}

/**
 * A beam is complete only when every retained branch has consumed its queue.
 * Pieces may be either placed or recorded in that branch's unplaced bucket.
 */
export function isBeamComplete(state: NestingAlgorithmState): boolean {
  return beamMembers(state).every((member) => member.remainingPieces.length === 0)
}

/**
 * Advances one branch when its next piece cannot be placed.
 * This keeps the beam non-empty and lets later pieces still be attempted.
 */
export function markNextPieceUnplaced(state: NestingBeamState): NestingBeamState {
  const piece = state.remainingPieces[0]
  if (piece === undefined) return state

  return new NestingBeamState({
    placements: state.placements,
    freeRectangles: state.freeRectangles,
    // failed placement consumes only the current piece
    remainingPieces: state.remainingPieces.slice(1),
    unplacedPieces: [...state.unplacedPieces, piece]
  })
}
