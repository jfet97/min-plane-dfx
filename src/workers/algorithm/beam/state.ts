import type { FreeRectangle, Placement, PreparedPiece } from '@shared/domain/nesting.js'

// retained beam width
export const K = 5

/**
 * One partial layout kept inside the beam.
 * This is the unit compared by the state order and rendered as one history rank.
 */
export interface NestingBeamState {
  readonly placements: ReadonlyArray<Placement>
  readonly freeRectangles: ReadonlyArray<FreeRectangle>
  /** Pieces still scheduled for future placement attempts, in original order. */
  readonly remainingPieces: ReadonlyArray<PreparedPiece>
  /** Pieces already rejected by this beam state because they did not fit. */
  readonly unplacedPieces: ReadonlyArray<PreparedPiece>
}

/**
 * Ranked beam container for one algorithm step.
 * `top` is rank 0; `alternatives` contains the remaining retained states.
 */
export interface NestingAlgorithmState {
  readonly top: NestingBeamState
  readonly alternatives: ReadonlyArray<NestingBeamState>
}
