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
export function beamFromMembers(members: ReadonlyArray<NestingBeamState>): NestingAlgorithmState {
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

// maximum remaining queue length across retained beam members
export function maxRemainingPieces(state: NestingAlgorithmState): number {
  return Math.max(...beamMembers(state).map((member) => member.remainingPieces.length))
}

/**
 * Removes beam states that are equivalent for future search.
 * Free-rectangle ids are intentionally ignored because split ids are generated;
 * the geometry and queued/rejected pieces are what affect later decisions.
 */
export function dedupeBeamStates(
  states: ReadonlyArray<NestingBeamState>
): ReadonlyArray<NestingBeamState> {
  const byKey = new Map<string, NestingBeamState>()
  for (const state of states) {
    byKey.set(beamStateKey(state), state)
  }
  return [...byKey.values()]
}

/**
 * Serializes the search-relevant shape of a beam state.
 * Placement order is kept because it is the committed history for rendering;
 * free rectangles are sorted because MaxRects availability is a set.
 */
function beamStateKey(state: NestingBeamState): string {
  const placements = state.placements
    .map(
      (placement) =>
        `${placement.pieceId}:${placement.x}:${placement.y}:${placement.width}:${placement.height}:${placement.rotation}`
    )
    .join('|')
  const freeRectangles = state.freeRectangles
    .map((rect) => `${rect.x}:${rect.y}:${rect.width}:${rect.height}`)
    .toSorted()
    .join('|')
  const remaining = state.remainingPieces.map((piece) => piece.id).join('|')
  const unplaced = state.unplacedPieces.map((piece) => piece.id).join('|')
  return `${placements}::${freeRectangles}::${remaining}::${unplaced}`
}
