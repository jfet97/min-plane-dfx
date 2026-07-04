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
  // strategy id of the candidate order that claimed this placement, or null
  // while it still sits in the strategy-agnostic pool before being claimed
  readonly candidateOrderId: string | null

  constructor(input: {
    readonly state: NestingBeamState
    readonly piece: PreparedPiece
    readonly freeRectangle: FreeRectangle
    readonly rotated: boolean
    readonly placement: Placement
    readonly candidateOrderId: string | null
  }) {
    this.candidateId = randomUUID()
    this.state = input.state
    this.piece = input.piece
    this.freeRectangle = input.freeRectangle
    this.rotated = input.rotated
    this.placement = input.placement
    this.candidateOrderId = input.candidateOrderId
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
 * Stable placement identity used only while selecting successors.
 * Candidate ids are unique object ids, but dedupe needs semantic identity:
 * same piece, same bottom-left point, same size, same rotation.
 */
export function candidatePlacementKey(candidate: NestingAlgorithmCandidate): string {
  const placement = candidate.placement
  return [
    placement.pieceId,
    placement.x,
    placement.y,
    placement.width,
    placement.height,
    placement.rotation
  ].join(':')
}

/**
 * Commits a selected candidate into the next beam state.
 * Candidate generation only describes possible moves; this is the transition
 * point that mutates placements, free rectangles, and the remaining queue.
 */
export function applyCandidate(candidate: NestingAlgorithmCandidate): AppliedCandidate {
  const splitRectangles = FreeRectangles.split(candidate.freeRectangle, candidate.placement)

  // maxRects records can overlap, so the selected rectangle is not the only
  // availability record that may contain the committed placement.
  const prunedRectangles = candidate.state.freeRectangles.filter(
    (freeRectangle) =>
      freeRectangle.id !== candidate.freeRectangle.id &&
      FreeRectangles.intersects(freeRectangle, candidate.placement)
  )

  // subtract from every free rectangle, then re-add only positive remnants.
  // this keeps later candidates from being generated inside occupied space.
  const freeRectangles = candidate.state.freeRectangles.reduce<FreeRectangle[]>(
    (rectangles, freeRectangle) =>
      FreeRectangles.split(freeRectangle, candidate.placement).reduce(
        (next, splitRectangle) => FreeRectangles.add(next, splitRectangle),
        rectangles
      ),
    []
  )

  const nextPiece = candidate.state.remainingPieces[0]
  if (nextPiece !== candidate.piece) {
    throw new Error(`Candidate piece ${candidate.piece.id} is not the next remaining piece`)
  }

  // fail loudly if the split/add pipeline leaves any occupied overlap behind
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
      // runMaxRectsBeamSearch only builds candidates for remainingPieces[0]
      remainingPieces: candidate.state.remainingPieces.slice(1),
      unplacedPieces: candidate.state.unplacedPieces
    }),
    split: {
      before: candidate.freeRectangle,
      after: splitRectangles,
      pruned: prunedRectangles
    }
  })
}
