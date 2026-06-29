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

export class AppliedCandidate {
  readonly candidate: NestingAlgorithmCandidate
  readonly state: NestingBeamState
  readonly split: {
    readonly before: FreeRectangle
    readonly after: ReadonlyArray<FreeRectangle>
    readonly pruned: ReadonlyArray<FreeRectangle>
  }

  constructor(input: {
    readonly candidate: NestingAlgorithmCandidate
    readonly state: NestingBeamState
    readonly split: {
      readonly before: FreeRectangle
      readonly after: ReadonlyArray<FreeRectangle>
      readonly pruned: ReadonlyArray<FreeRectangle>
    }
  }) {
    this.candidate = input.candidate
    this.state = input.state
    this.split = input.split
  }
}

/**
 * Commits a selected candidate into the next beam state.
 * Candidate generation only describes possible moves; this is the transition
 * point that mutates placements, free rectangles, and the remaining queue.
 */
export function applyCandidate(candidate: NestingAlgorithmCandidate): AppliedCandidate {
  const splitRectangles = FreeRectangles.split(candidate.freeRectangle, candidate.placement)
  const prunedRectangles = candidate.state.freeRectangles.filter(
    (freeRectangle) =>
      freeRectangle.id !== candidate.freeRectangle.id &&
      FreeRectangles.intersects(freeRectangle, candidate.placement)
  )

  // the placement must be subtracted from every intersecting free rectangle
  const freeRectangles = candidate.state.freeRectangles.reduce<FreeRectangle[]>(
    (rectangles, freeRectangle) =>
      FreeRectangles.split(freeRectangle, candidate.placement).reduce(
        (next, splitRectangle) => FreeRectangles.add(next, splitRectangle),
        rectangles
      ),
    []
  )

  const remainingPieces = candidate.state.remainingPieces.filter(
    (piece) => piece.id !== candidate.piece.id
  )

  for (const freeRectangle of freeRectangles) {
    if (FreeRectangles.intersects(freeRectangle, candidate.placement)) {
      throw new Error(
        `Free rectangle ${freeRectangle.id} still intersects placement ${candidate.placement.pieceId}`
      )
    }
  }

  return new AppliedCandidate({
    candidate,
    state: new NestingBeamState({
      placements: [...candidate.state.placements, candidate.placement],
      freeRectangles,
      remainingPieces,
      unplacedPieces: candidate.state.unplacedPieces
    }),
    split: {
      before: candidate.freeRectangle,
      after: splitRectangles,
      pruned: prunedRectangles
    }
  })
}
