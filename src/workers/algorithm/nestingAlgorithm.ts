import type { Order } from 'effect'
import type { FreeRectangle, Placement, PreparedPiece, SheetSpec } from '@shared/domain/nesting.js'
import type { PieceId } from '@shared/domain/ids.js'

export interface NestingAlgorithmState {
  readonly placements: ReadonlyArray<Placement>
  readonly freeRectangles: ReadonlyArray<FreeRectangle>
  readonly remainingPieces: ReadonlyArray<PreparedPiece>
}

export interface FreeRectangleOrderContext {
  readonly state: NestingAlgorithmState
  readonly piece: PreparedPiece
  readonly rotated: boolean
}

export type FreeRectangleOrderForPiece = (
  context: FreeRectangleOrderContext
) => Order.Order<FreeRectangle>

export type NestingStateOrder = Order.Order<NestingAlgorithmState>

export interface NestingAlgorithmCandidate {
  readonly candidateId: string
  readonly state: NestingAlgorithmState
  readonly piece: PreparedPiece
  readonly freeRectangle: FreeRectangle
  readonly rotated: boolean
  readonly placement?: Placement
  readonly score?: ReadonlyArray<number>
}

export interface NestingAlgorithmFreeRectangleSplit {
  readonly before: FreeRectangle
  readonly after: ReadonlyArray<FreeRectangle>
  readonly pruned: ReadonlyArray<FreeRectangle>
}

export type NestingAlgorithmEvent =
  | {
      readonly type: 'initial_state'
      readonly state: NestingAlgorithmState
    }
  | {
      readonly type: 'beam_step'
      readonly stepIndex: number
      readonly beam: ReadonlyArray<NestingAlgorithmState>
      readonly candidates: ReadonlyArray<NestingAlgorithmCandidate>
    }
  | {
      readonly type: 'candidate_ranked'
      readonly stepIndex: number
      readonly candidate: NestingAlgorithmCandidate
    }
  | {
      readonly type: 'state_selected'
      readonly stepIndex: number
      readonly beamRank: number
      readonly state: NestingAlgorithmState
    }
  | {
      readonly type: 'placement_committed'
      readonly stepIndex: number
      readonly beamRank: number
      readonly previousState: NestingAlgorithmState
      readonly nextState: NestingAlgorithmState
      readonly candidate: NestingAlgorithmCandidate
    }
  | {
      readonly type: 'free_rectangles_split'
      readonly stepIndex: number
      readonly beamRank: number
      readonly piece: PreparedPiece
      readonly split: NestingAlgorithmFreeRectangleSplit
    }
  | {
      readonly type: 'completed'
      readonly outcome: NestingAlgorithmOutcome
    }

export interface NestingAlgorithmHooks {
  readonly onEvent?: (event: NestingAlgorithmEvent) => void
}

export interface NestingAlgorithmInput {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<PreparedPiece>
  readonly freeRectangleOrder: FreeRectangleOrderForPiece
  readonly stateOrder: NestingStateOrder
  readonly hooks?: NestingAlgorithmHooks
}

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
