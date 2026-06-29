import type { Order } from 'effect'
import type { PreparedPiece, SheetSpec } from '@shared/domain/nesting.js'
import {
  applyCandidate,
  candidatePlacementKey,
  NestingAlgorithmCandidate
} from './beam/candidates.js'
import { initialState } from './beam/seed.js'
import {
  beamFromMembers,
  beamMembers,
  dedupeBeamStates,
  isBeamComplete,
  markNextPieceUnplaced,
  maxRemainingPieces,
  type NestingBeamState
} from './beam/state.js'
import { NestingAlgorithmEvents, type NestingAlgorithmEvent } from './events.js'
import { makeBottomLeftPlacement } from './maxRects/placements.js'
import { FreeRectangles } from './maxRects/freeRectangles.js'
export { K } from './beam/state.js'
export type { NestingAlgorithmState, NestingBeamState } from './beam/state.js'
export { initialState } from './beam/seed.js'
export {
  NestingAlgorithmEvents,
  type NestingAlgorithmEvent,
  type NestingAlgorithmScoredCandidate
} from './events.js'

// candidate placements retained per state/piece/strategy at most
export const freeRectFanout = 2

/**
 * Strategy hook that returns the candidate placement order for one decision point.
 * The wrapper owns how configured strategy ids become this function.
 */
export type CandidateOrder = (context: {
  sheet: SheetSpec
}) => Order.Order<NestingAlgorithmCandidate>

export class CandidateOrderEntry {
  readonly strategyId: string
  readonly order: CandidateOrder

  constructor(input: { readonly strategyId: string; readonly order: CandidateOrder }) {
    this.strategyId = input.strategyId
    this.order = input.order
  }
}

export type CandidateOrders = ReadonlyArray<CandidateOrderEntry>

/**
 * Beam survivor order for partial layout states.
 * After expansion, this decides which states stay alive for the next piece.
 */
export type NestingStateOrder = () => Order.Order<NestingBeamState>

export { NestingAlgorithmCandidate } from './beam/candidates.js'

/**
 * Algorithm-core boundary for MaxRects beam search.
 *
 * Each `candidateOrder` entry ranks legal placement candidates for the current
 * state/piece, and `stateOrder` keeps the beam survivors after expansion.
 */
export function runMaxRectsBeamSearch(input: {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<PreparedPiece>
  readonly beamWidth: number
  readonly candidateOrder: CandidateOrders
  readonly stateOrder: NestingStateOrder
  // synchronous hooks
  readonly hooks?: {
    readonly onEvent?: (event: NestingAlgorithmEvent) => void
  }
}) {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  input.hooks?.onEvent?.(NestingAlgorithmEvents.started({ startedAt }))

  let state = initialState(input)

  input.hooks?.onEvent?.(NestingAlgorithmEvents.initialState(state))

  let stepIndex = 0
  let previousMaxRemaining = maxRemainingPieces(state)

  while (!isBeamComplete(state)) {
    if (stepIndex > input.pieces.length) {
      throw new Error(
        `Beam search did not terminate after ${stepIndex} steps for ${input.pieces.length} pieces.`
      )
    }

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

      const candidates: NestingAlgorithmCandidate[] = []

      // build the legal move list once for this beam member and next piece.
      // selected strategies are only different orderings over this same list.
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
              placement,
              // null until a candidate order claims this placement
              // (distinct from any real strategy id, including "")
              candidateOrderId: null
            })
          )
        }
      }
      stepCandidates.push(...candidates)

      const selectedCandidates = new Map<string, NestingAlgorithmCandidate>()
      for (const { strategyId, order: candidateOrder } of input.candidateOrder) {
        const order = candidateOrder({ sheet: input.sheet })

        // each strategy gets its own top-N view; duplicates are collapsed so
        // agreeing strategies do not fork the beam. First claim wins attribution.
        for (const candidate of candidates.toSorted(order).slice(0, freeRectFanout)) {
          const key = candidatePlacementKey(candidate)
          if (selectedCandidates.has(key)) {
            continue
          }
          selectedCandidates.set(
            key,
            new NestingAlgorithmCandidate({
              state: candidate.state,
              piece: candidate.piece,
              freeRectangle: candidate.freeRectangle,
              rotated: candidate.rotated,
              placement: candidate.placement,
              candidateOrderId: strategyId
            })
          )
        }
      }

      if (selectedCandidates.size > 0) {
        for (const candidate of selectedCandidates.values()) {
          const applied = applyCandidate(candidate)
          successorStates.push(applied.state)
          input.hooks?.onEvent?.(
            NestingAlgorithmEvents.placementApplied({
              stepIndex,
              beamRank,
              applied
            })
          )
        }
      } else {
        // no legal placement is still progress: reject this piece and keep the branch alive
        successorStates.push(markNextPieceUnplaced(s))
      }
    }

    input.hooks?.onEvent?.(
      NestingAlgorithmEvents.beamStep({
        stepIndex,
        beamSize: beamMembers(state).length,
        candidateCount: stepCandidates.length
      })
    )

    // all unique generated branches compete globally; only the best beamWidth survive.
    // without this, two strategies that pick the same move can waste beam slots.
    const nextBeamMembers = dedupeBeamStates(successorStates)
      .toSorted(input.stateOrder())
      .slice(0, input.beamWidth)

    state = beamFromMembers(nextBeamMembers)
    const nextMaxRemaining = maxRemainingPieces(state)
    if (nextMaxRemaining >= previousMaxRemaining && !isBeamComplete(state)) {
      throw new Error(
        `Beam search made no progress at step ${stepIndex}: remaining pieces stayed at ${nextMaxRemaining}.`
      )
    }
    previousMaxRemaining = nextMaxRemaining
    for (const [beamRank, member] of nextBeamMembers.entries()) {
      input.hooks?.onEvent?.(
        NestingAlgorithmEvents.stateSelected({ stepIndex, beamRank, state: member })
      )
    }
    stepIndex++
  }

  // sortedPieceIds is the attempted order, including pieces that ended up unplaced
  const outcome = {
    sortedPieceIds: input.pieces.map((piece) => piece.id),
    placements: state.top.placements,
    unplacedPieceIds: state.top.unplacedPieces.map((piece) => piece.id)
  }
  const endedAtMs = Date.now()
  const benchmark = {
    startedAt,
    endedAt: new Date(endedAtMs).toISOString(),
    elapsedMs: endedAtMs - startedAtMs
  }

  input.hooks?.onEvent?.(NestingAlgorithmEvents.completed({ outcome, benchmark }))

  return outcome
}
