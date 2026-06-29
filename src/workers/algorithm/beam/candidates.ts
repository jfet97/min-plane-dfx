import { randomUUID } from 'node:crypto'
import type { FreeRectangle, Placement, PreparedPiece } from '@shared/domain/nesting.js'
import { FreeRectangles } from '../maxRects/freeRectangles.js'
import { NestingBeamState } from './state.js'

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
 * Commits a selected candidate into the next beam state.
 * Candidate generation only describes possible moves; this is the transition
 * point that mutates placements, free rectangles, and the remaining queue.
 */
export function applyCandidate(candidate: NestingAlgorithmCandidate): NestingBeamState {
  const splitRectangles = FreeRectangles.split(candidate.freeRectangle, candidate.placement)

  // split output is re-added through the maximal-rectangle dedupe rule
  const freeRectangles = splitRectangles.reduce(
    (rectangles, freeRectangle) => FreeRectangles.add(rectangles, freeRectangle),
    // the selected free rectangle is consumed by the placement
    candidate.state.freeRectangles.filter(
      (freeRectangle) => freeRectangle.id !== candidate.freeRectangle.id
    )
  )

  return new NestingBeamState({
    placements: [...candidate.state.placements, candidate.placement],
    freeRectangles,
    remainingPieces: candidate.state.remainingPieces.filter(
      (piece) => piece.id !== candidate.piece.id
    ),
    unplacedPieces: candidate.state.unplacedPieces
  })
}
