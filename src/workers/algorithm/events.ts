import type { AlgorithmBenchmark, FreeRectangle, Placement } from '@shared/domain/nesting.js'
import type { FreeRectId, PieceId } from '@shared/domain/ids.js'
import type { AppliedCandidate } from './beam/candidates.js'
import type { NestingAlgorithmState, NestingBeamState } from './beam/state.js'

/**
 * Lightweight ranked-candidate trace.
 * It carries only stable event data, not the full candidate object.
 */
export interface NestingAlgorithmScoredCandidate {
  readonly candidateId: string
  readonly score: ReadonlyArray<number>
}

/**
 * First lifecycle event for the core algorithm.
 * It marks the benchmark start before seed construction or candidate work.
 */
export class AlgorithmStartedEvent {
  readonly type = 'algorithm_started'
  readonly startedAt: string

  constructor(input: { readonly startedAt: string }) {
    this.startedAt = input.startedAt
  }
}

/**
 * First event for a strategy run.
 * It gives the wrapper a concrete starting state for history.
 */
export class InitialStateEvent {
  readonly type = 'initial_state'
  readonly state: NestingAlgorithmState

  constructor(input: { readonly state: NestingAlgorithmState }) {
    this.state = input.state
  }
}

/**
 * Candidate-expansion event for one algorithm step.
 * It records counts only; candidate details are emitted by placement events.
 */
export class BeamStepEvent {
  readonly type = 'beam_step'
  readonly stepIndex: number
  readonly beamSize: number
  readonly candidateCount: number

  constructor(input: {
    readonly stepIndex: number
    readonly beamSize: number
    readonly candidateCount: number
  }) {
    this.stepIndex = input.stepIndex
    this.beamSize = input.beamSize
    this.candidateCount = input.candidateCount
  }
}

/**
 * Candidate scoring event.
 * It lets history explain why a candidate was ranked before selection.
 */
export class CandidateRankedEvent {
  readonly type = 'candidate_ranked'
  readonly stepIndex: number
  readonly scoredCandidate: NestingAlgorithmScoredCandidate

  constructor(input: {
    readonly stepIndex: number
    readonly scoredCandidate: NestingAlgorithmScoredCandidate
  }) {
    this.stepIndex = input.stepIndex
    this.scoredCandidate = input.scoredCandidate
  }
}

/**
 * Beam survivor event.
 * It records which partial state survived and at which beam rank.
 */
export class StateSelectedEvent {
  readonly type = 'state_selected'
  readonly stepIndex: number
  readonly beamRank: number
  readonly state: NestingBeamState

  constructor(input: {
    readonly stepIndex: number
    readonly beamRank: number
    readonly state: NestingBeamState
  }) {
    this.stepIndex = input.stepIndex
    this.beamRank = input.beamRank
    this.state = input.state
  }
}

/**
 * Placement application event.
 * It keeps the applied candidate class out of the event payload.
 */
export class PlacementAppliedEvent {
  readonly type = 'placement_applied'
  readonly stepIndex: number
  readonly beamRank: number
  readonly candidateId: string
  // strategy id of the order that claimed this placement; always a string
  // because a placement is only applied after an order claims it
  readonly candidateOrderId: string
  readonly pieceId: PieceId
  readonly freeRectangleId: FreeRectId
  readonly rotated: boolean
  readonly placement: Placement
  readonly split: {
    readonly before: FreeRectangle
    readonly after: ReadonlyArray<FreeRectangle>
    readonly pruned: ReadonlyArray<FreeRectangle>
  }

  constructor(input: {
    readonly stepIndex: number
    readonly beamRank: number
    readonly candidateId: string
    readonly candidateOrderId: string
    readonly pieceId: PieceId
    readonly freeRectangleId: FreeRectId
    readonly rotated: boolean
    readonly placement: Placement
    readonly split: {
      readonly before: FreeRectangle
      readonly after: ReadonlyArray<FreeRectangle>
      readonly pruned: ReadonlyArray<FreeRectangle>
    }
  }) {
    this.stepIndex = input.stepIndex
    this.beamRank = input.beamRank
    this.candidateId = input.candidateId
    this.candidateOrderId = input.candidateOrderId
    this.pieceId = input.pieceId
    this.freeRectangleId = input.freeRectangleId
    this.rotated = input.rotated
    this.placement = input.placement
    this.split = input.split
  }
}

/**
 * Final event for a strategy run.
 * It gives the wrapper the same outcome returned by the algorithm core.
 */
export class CompletedEvent {
  readonly type = 'completed'
  readonly benchmark: AlgorithmBenchmark
  readonly outcome: {
    readonly sortedPieceIds: ReadonlyArray<PieceId>
    readonly placements: ReadonlyArray<Placement>
    readonly unplacedPieceIds: ReadonlyArray<PieceId>
  }

  constructor(input: {
    readonly outcome: {
      readonly sortedPieceIds: ReadonlyArray<PieceId>
      readonly placements: ReadonlyArray<Placement>
      readonly unplacedPieceIds: ReadonlyArray<PieceId>
    }
    readonly benchmark: AlgorithmBenchmark
  }) {
    this.outcome = input.outcome
    this.benchmark = input.benchmark
  }
}

/**
 * Union of every algorithm event state.
 * Consumers should switch on `type` and translate only the events they need.
 */
export type NestingAlgorithmEvent =
  | AlgorithmStartedEvent
  | InitialStateEvent
  | BeamStepEvent
  | CandidateRankedEvent
  | StateSelectedEvent
  | PlacementAppliedEvent
  | CompletedEvent

export const NestingAlgorithmEvents = {
  started(input: { readonly startedAt: string }): AlgorithmStartedEvent {
    return new AlgorithmStartedEvent(input)
  },
  initialState(state: NestingAlgorithmState): InitialStateEvent {
    return new InitialStateEvent({ state })
  },
  beamStep(input: {
    readonly stepIndex: number
    readonly beamSize: number
    readonly candidateCount: number
  }): BeamStepEvent {
    return new BeamStepEvent(input)
  },
  candidateRanked(input: {
    readonly stepIndex: number
    readonly scoredCandidate: NestingAlgorithmScoredCandidate
  }): CandidateRankedEvent {
    return new CandidateRankedEvent(input)
  },
  stateSelected(input: {
    readonly stepIndex: number
    readonly beamRank: number
    readonly state: NestingBeamState
  }): StateSelectedEvent {
    return new StateSelectedEvent(input)
  },
  placementApplied(input: {
    readonly stepIndex: number
    readonly beamRank: number
    readonly applied: AppliedCandidate
  }): PlacementAppliedEvent {
    const { candidate } = input.applied
    // a placement is only ever applied after an order claims the candidate, so
    // candidateOrderId is a real strategy id here; guard enforces the invariant
    const candidateOrderId = candidate.candidateOrderId
    if (candidateOrderId === null) {
      throw new Error(
        `PlacementAppliedEvent emitted for unclaimed candidate ${candidate.candidateId}`
      )
    }
    return new PlacementAppliedEvent({
      stepIndex: input.stepIndex,
      beamRank: input.beamRank,
      candidateId: candidate.candidateId,
      candidateOrderId,
      pieceId: candidate.piece.id,
      freeRectangleId: candidate.freeRectangle.id,
      rotated: candidate.rotated,
      placement: candidate.placement,
      split: input.applied.split
    })
  },
  completed(input: {
    readonly outcome: CompletedEvent['outcome']
    readonly benchmark: AlgorithmBenchmark
  }): CompletedEvent {
    return new CompletedEvent(input)
  }
}
