import type { Order } from 'effect'
import { FreeRectangle, Placement, PreparedPiece, SheetSpec } from '@shared/domain/nesting.js'
import type { PieceId } from '@shared/domain/ids.js'

// retained beam width
export const MAX_RETAINED_STATES = 5

// free rectangles considered per state/piece/orientation at most
export const FREE_RECTANGLE_FANOUT = 2

/**
 * One partial layout kept inside the beam.
 * This is the unit compared by the state order and rendered as one history rank.
 */
export interface NestingBeamState {
  readonly placements: ReadonlyArray<Placement>
  readonly freeRectangles: ReadonlyArray<FreeRectangle>
  readonly remainingPieces: ReadonlyArray<PreparedPiece>
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

export const FreeRectangleOps = {
  /**
   * Adds a free rectangle unless it is fully contained by an existing one.
   * The free-rectangle set is kept maximal by invariant: new rectangles come
   * from splits, so they can be redundant only by being smaller than an
   * existing rectangle, not by containing one.
   */
  add(rects: readonly FreeRectangle[], newRect: FreeRectangle): FreeRectangle[] {
    for (const rect of rects) {
      if (
        newRect.x >= rect.x &&
        newRect.x + newRect.width <= rect.x + rect.width &&
        newRect.y >= rect.y &&
        newRect.y + newRect.height <= rect.y + rect.height
      ) {
        return [...rects]
      }
    }

    return [newRect, ...rects]
  },

  split(rect: FreeRectangle, placement: Placement): FreeRectangle[] {
    const rectRight = rect.x + rect.width
    const rectBottom = rect.y + rect.height
    const placementRight = placement.x + placement.width
    const placementBottom = placement.y + placement.height

    // invariant check: the placement must fit inside the free rectangle
    if (
      placement.x < rect.x ||
      placement.y < rect.y ||
      placementRight > rectRight ||
      placementBottom > rectBottom
    ) {
      throw new Error(
        `Placement for piece ${placement.pieceId} does not fit inside free rectangle ${rect.id}`
      )
    }

    const leftRect =
      placement.x - rect.x > 0
        ? new FreeRectangle({
            x: rect.x,
            y: rect.y,
            width: placement.x - rect.x,
            height: rect.height,
            source: 'split'
          })
        : null
    const rightRect =
      placementRight < rectRight
        ? new FreeRectangle({
            x: placementRight,
            y: rect.y,
            width: rectRight - placementRight,
            height: rect.height,
            source: 'split'
          })
        : null
    const topRect =
      placement.y - rect.y > 0
        ? new FreeRectangle({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: placement.y - rect.y,
            source: 'split'
          })
        : null
    const bottomRect =
      placementBottom < rectBottom
        ? new FreeRectangle({
            x: rect.x,
            y: placementBottom,
            width: rect.width,
            height: rectBottom - placementBottom,
            source: 'split'
          })
        : null

    return [leftRect, rightRect, topRect, bottomRect].filter((r): r is FreeRectangle => !!r)
  }
} as const

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
  const top = {
    placements: [],
    freeRectangles: [
      new FreeRectangle({
        width: input.sheet.width,
        height: input.sheet.height,
        x: 0,
        y: 0
      })
    ],
    remainingPieces: input.pieces
  } satisfies NestingBeamState
  const state = {
    top,
    alternatives: []
  } satisfies NestingAlgorithmState

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
