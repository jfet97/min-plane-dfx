export interface IrregularDecisionTraceIdentity {
  readonly decodeId: string
  readonly chromosomeId: string
  readonly decodeSource: 'baseline' | 'ga' | 'direct'
}

type EventInput<Payload> = IrregularDecisionTraceIdentity & Payload

class IrregularDecisionTraceIdRegistry {
  private readonly idsByCanonicalKey = new Map<string, string>()
  private nextId = 0

  constructor(private readonly prefix: string) {}

  idFor(canonicalKey: string): string {
    const existing = this.idsByCanonicalKey.get(canonicalKey)
    if (existing !== undefined) return existing

    const id = `${this.prefix}${this.nextId.toString(36)}`
    this.nextId += 1
    this.idsByCanonicalKey.set(canonicalKey, id)
    return id
  }
}

/** Assigns collision-free short state ids in deterministic first-seen order. */
export class IrregularDecisionTraceStateIdRegistry extends IrregularDecisionTraceIdRegistry {
  constructor() {
    super('s')
  }
}

/** Assigns collision-free short candidate ids in deterministic first-seen order. */
export class IrregularDecisionTraceCandidateIdRegistry extends IrregularDecisionTraceIdRegistry {
  constructor() {
    super('k')
  }
}

/** Assigns collision-free short chromosome ids in deterministic first-seen order. */
export class IrregularDecisionTraceChromosomeIdRegistry extends IrregularDecisionTraceIdRegistry {
  constructor() {
    super('c')
  }
}

export abstract class IrregularDecisionTraceEventBase {
  readonly decodeId: string
  readonly chromosomeId: string
  readonly decodeSource: 'baseline' | 'ga' | 'direct'

  protected constructor(input: IrregularDecisionTraceIdentity) {
    this.decodeId = input.decodeId
    this.chromosomeId = input.chromosomeId
    this.decodeSource = input.decodeSource
  }
}

export class IrregularDecisionTracePoint {
  readonly x: number
  readonly y: number

  constructor(input: { readonly x: number; readonly y: number }) {
    this.x = input.x
    this.y = input.y
  }
}

export class IrregularDecisionTraceTransform {
  readonly index: number
  readonly rotationDeg: number
  readonly mirrored: boolean
  readonly reason: string

  constructor(input: {
    readonly index: number
    readonly rotationDeg: number
    readonly mirrored: boolean
    readonly reason: string
  }) {
    this.index = input.index
    this.rotationDeg = input.rotationDeg
    this.mirrored = input.mirrored
    this.reason = input.reason
  }
}

export class IrregularDecisionTraceTransformPreference {
  readonly pieceId: string
  readonly transformIndex: number

  constructor(input: { readonly pieceId: string; readonly transformIndex: number }) {
    this.pieceId = input.pieceId
    this.transformIndex = input.transformIndex
  }
}

export class IrregularDecisionTraceState {
  readonly stateId: string
  readonly placementOrder: ReadonlyArray<string>
  readonly remainingPieceIds: ReadonlyArray<string>
  readonly unplacedPieceIds: ReadonlyArray<string>

  constructor(input: {
    readonly stateId: string
    readonly placementOrder: ReadonlyArray<string>
    readonly remainingPieceIds: ReadonlyArray<string>
    readonly unplacedPieceIds: ReadonlyArray<string>
  }) {
    this.stateId = input.stateId
    this.placementOrder = [...input.placementOrder]
    this.remainingPieceIds = [...input.remainingPieceIds]
    this.unplacedPieceIds = [...input.unplacedPieceIds]
  }
}

export class IrregularDecisionTraceLocalScore {
  readonly worstNormalizedSheetConsumption: number
  readonly normalizedSheetSpanSum: number
  readonly usedClusterAreaMm2: number
  readonly usedClusterSpanMm: number
  readonly shortSideFill: number
  readonly longSideFill: number
  readonly sharedCollisionBoundaryLengthMm: number
  readonly candidateBottomMm: number
  readonly candidateLeftMm: number

  constructor(input: {
    readonly worstNormalizedSheetConsumption: number
    readonly normalizedSheetSpanSum: number
    readonly usedClusterAreaMm2: number
    readonly usedClusterSpanMm: number
    readonly shortSideFill: number
    readonly longSideFill: number
    readonly sharedCollisionBoundaryLengthMm: number
    readonly candidateBottomMm: number
    readonly candidateLeftMm: number
  }) {
    this.worstNormalizedSheetConsumption = input.worstNormalizedSheetConsumption
    this.normalizedSheetSpanSum = input.normalizedSheetSpanSum
    this.usedClusterAreaMm2 = input.usedClusterAreaMm2
    this.usedClusterSpanMm = input.usedClusterSpanMm
    this.shortSideFill = input.shortSideFill
    this.longSideFill = input.longSideFill
    this.sharedCollisionBoundaryLengthMm = input.sharedCollisionBoundaryLengthMm
    this.candidateBottomMm = input.candidateBottomMm
    this.candidateLeftMm = input.candidateLeftMm
  }
}

export class IrregularDecisionTraceLayoutScore {
  readonly unplacedCount: number
  readonly sharedCollisionBoundaryLengthMm: number
  readonly sharedCollisionBoundaryContactUnits: number
  readonly sharedCollisionBoundaryContactBand: number
  readonly nearCompleteStructuralContactCount: number
  readonly dominantNearCompleteStructuralContactCount: number
  readonly occupiedHullWasteRatio: number
  readonly collisionBoundsWorstNormalizedSheetConsumption: number
  readonly collisionBoundsNormalizedSpanSum: number
  readonly collisionBoundsAreaMm2: number
  readonly collisionBoundsSpanMm: number
  readonly largestNetFreeMaterialRegionAreaMm2: number
  readonly freeMaterialRegionCount: number
  readonly freeMaterialHoleCount: number
  readonly freeMaterialSliverMetric: number
  readonly collisionBoundsBottomMm: number
  readonly collisionBoundsLeftMm: number

  constructor(input: {
    readonly unplacedCount: number
    readonly sharedCollisionBoundaryLengthMm: number
    readonly sharedCollisionBoundaryContactUnits: number
    readonly sharedCollisionBoundaryContactBand: number
    readonly nearCompleteStructuralContactCount: number
    readonly dominantNearCompleteStructuralContactCount: number
    readonly occupiedHullWasteRatio: number
    readonly collisionBoundsWorstNormalizedSheetConsumption: number
    readonly collisionBoundsNormalizedSpanSum: number
    readonly collisionBoundsAreaMm2: number
    readonly collisionBoundsSpanMm: number
    readonly largestNetFreeMaterialRegionAreaMm2: number
    readonly freeMaterialRegionCount: number
    readonly freeMaterialHoleCount: number
    readonly freeMaterialSliverMetric: number
    readonly collisionBoundsBottomMm: number
    readonly collisionBoundsLeftMm: number
  }) {
    this.unplacedCount = input.unplacedCount
    this.sharedCollisionBoundaryLengthMm = input.sharedCollisionBoundaryLengthMm
    this.sharedCollisionBoundaryContactUnits = input.sharedCollisionBoundaryContactUnits
    this.sharedCollisionBoundaryContactBand = input.sharedCollisionBoundaryContactBand
    this.nearCompleteStructuralContactCount = input.nearCompleteStructuralContactCount
    this.dominantNearCompleteStructuralContactCount =
      input.dominantNearCompleteStructuralContactCount
    this.occupiedHullWasteRatio = input.occupiedHullWasteRatio
    this.collisionBoundsWorstNormalizedSheetConsumption =
      input.collisionBoundsWorstNormalizedSheetConsumption
    this.collisionBoundsNormalizedSpanSum = input.collisionBoundsNormalizedSpanSum
    this.collisionBoundsAreaMm2 = input.collisionBoundsAreaMm2
    this.collisionBoundsSpanMm = input.collisionBoundsSpanMm
    this.largestNetFreeMaterialRegionAreaMm2 = input.largestNetFreeMaterialRegionAreaMm2
    this.freeMaterialRegionCount = input.freeMaterialRegionCount
    this.freeMaterialHoleCount = input.freeMaterialHoleCount
    this.freeMaterialSliverMetric = input.freeMaterialSliverMetric
    this.collisionBoundsBottomMm = input.collisionBoundsBottomMm
    this.collisionBoundsLeftMm = input.collisionBoundsLeftMm
  }
}

export class IrregularDecisionTraceSheet {
  readonly widthMm: number
  readonly heightMm: number

  constructor(input: { readonly widthMm: number; readonly heightMm: number }) {
    this.widthMm = input.widthMm
    this.heightMm = input.heightMm
  }
}

export class IrregularDecisionTraceSearchSettings {
  readonly orderWindow: number
  readonly beamWidth: number
  readonly localCandidateFanout: number
  readonly localRepairBudget: number
  readonly policyId: string

  constructor(input: {
    readonly orderWindow: number
    readonly beamWidth: number
    readonly localCandidateFanout: number
    readonly localRepairBudget: number
    readonly policyId: string
  }) {
    this.orderWindow = input.orderWindow
    this.beamWidth = input.beamWidth
    this.localCandidateFanout = input.localCandidateFanout
    this.localRepairBudget = input.localRepairBudget
    this.policyId = input.policyId
  }
}

export class IrregularDecisionTraceDecodeStarted extends IrregularDecisionTraceEventBase {
  readonly kind = 'decode_started' as const
  readonly sheet: IrregularDecisionTraceSheet
  readonly settings: IrregularDecisionTraceSearchSettings
  readonly priorityOrder: ReadonlyArray<string>
  readonly transformPreferences: ReadonlyArray<IrregularDecisionTraceTransformPreference>

  constructor(
    input: EventInput<{
      readonly sheet: IrregularDecisionTraceSheet
      readonly settings: IrregularDecisionTraceSearchSettings
      readonly priorityOrder: ReadonlyArray<string>
      readonly transformPreferences: ReadonlyArray<IrregularDecisionTraceTransformPreference>
    }>
  ) {
    super(input)
    this.sheet = input.sheet
    this.settings = input.settings
    this.priorityOrder = [...input.priorityOrder]
    this.transformPreferences = [...input.transformPreferences]
  }
}

export class IrregularDecisionTraceBeamStepStarted extends IrregularDecisionTraceEventBase {
  readonly kind = 'beam_step_started' as const
  readonly stepIndex: number
  readonly parentCount: number

  constructor(input: EventInput<{ readonly stepIndex: number; readonly parentCount: number }>) {
    super(input)
    this.stepIndex = input.stepIndex
    this.parentCount = input.parentCount
  }
}

export class IrregularDecisionTraceParentState extends IrregularDecisionTraceEventBase {
  readonly kind = 'parent_state' as const
  readonly stepIndex: number
  readonly parentRank: number
  readonly incumbent: boolean
  readonly state: IrregularDecisionTraceState

  constructor(
    input: EventInput<{
      readonly stepIndex: number
      readonly parentRank: number
      readonly incumbent: boolean
      readonly state: IrregularDecisionTraceState
    }>
  ) {
    super(input)
    this.stepIndex = input.stepIndex
    this.parentRank = input.parentRank
    this.incumbent = input.incumbent
    this.state = input.state
  }
}

export class IrregularDecisionTraceEligiblePieces extends IrregularDecisionTraceEventBase {
  readonly kind = 'eligible_pieces' as const
  readonly stepIndex: number
  readonly parentStateId: string
  readonly pieceIds: ReadonlyArray<string>

  constructor(
    input: EventInput<{
      readonly stepIndex: number
      readonly parentStateId: string
      readonly pieceIds: ReadonlyArray<string>
    }>
  ) {
    super(input)
    this.stepIndex = input.stepIndex
    this.parentStateId = input.parentStateId
    this.pieceIds = [...input.pieceIds]
  }
}

export class IrregularDecisionTraceTransformCandidatesGenerated
  extends IrregularDecisionTraceEventBase {
  readonly kind = 'transform_candidates_generated' as const
  readonly stepIndex: number
  readonly parentStateId: string
  readonly pieceId: string
  readonly transform: IrregularDecisionTraceTransform
  readonly legalCandidateCount: number

  constructor(
    input: EventInput<{
      readonly stepIndex: number
      readonly parentStateId: string
      readonly pieceId: string
      readonly transform: IrregularDecisionTraceTransform
      readonly legalCandidateCount: number
    }>
  ) {
    super(input)
    this.stepIndex = input.stepIndex
    this.parentStateId = input.parentStateId
    this.pieceId = input.pieceId
    this.transform = input.transform
    this.legalCandidateCount = input.legalCandidateCount
  }
}

export class IrregularDecisionTraceLocalCandidateScored
  extends IrregularDecisionTraceEventBase {
  readonly kind = 'local_candidate_scored' as const
  readonly stepIndex: number
  readonly parentStateId: string
  readonly pieceId: string
  readonly candidateId: string
  readonly point: IrregularDecisionTracePoint
  readonly transform: IrregularDecisionTraceTransform
  readonly policyId: string
  readonly score: IrregularDecisionTraceLocalScore

  constructor(
    input: EventInput<{
      readonly stepIndex: number
      readonly parentStateId: string
      readonly pieceId: string
      readonly candidateId: string
      readonly point: IrregularDecisionTracePoint
      readonly transform: IrregularDecisionTraceTransform
      readonly policyId: string
      readonly score: IrregularDecisionTraceLocalScore
    }>
  ) {
    super(input)
    this.stepIndex = input.stepIndex
    this.parentStateId = input.parentStateId
    this.pieceId = input.pieceId
    this.candidateId = input.candidateId
    this.point = input.point
    this.transform = input.transform
    this.policyId = input.policyId
    this.score = input.score
  }
}

export class IrregularDecisionTraceLocalCandidateSelection
  extends IrregularDecisionTraceEventBase {
  readonly kind = 'local_candidate_selection' as const
  readonly stepIndex: number
  readonly parentStateId: string
  readonly pieceId: string
  readonly candidateId: string
  readonly rank: number
  readonly decision: 'selected' | 'rejected'
  readonly reason:
    | 'within_local_candidate_fanout'
    | 'compactness_alternative_reserved'
    | 'displaced_by_compactness_reservation'
    | 'duplicate_local_geometry'
    | 'outside_local_candidate_fanout'

  constructor(
    input: EventInput<{
      readonly stepIndex: number
      readonly parentStateId: string
      readonly pieceId: string
      readonly candidateId: string
      readonly rank: number
      readonly decision: 'selected' | 'rejected'
      readonly reason:
        | 'within_local_candidate_fanout'
        | 'compactness_alternative_reserved'
        | 'displaced_by_compactness_reservation'
        | 'duplicate_local_geometry'
        | 'outside_local_candidate_fanout'
    }>
  ) {
    super(input)
    this.stepIndex = input.stepIndex
    this.parentStateId = input.parentStateId
    this.pieceId = input.pieceId
    this.candidateId = input.candidateId
    this.rank = input.rank
    this.decision = input.decision
    this.reason = input.reason
  }
}

export class IrregularDecisionTraceSuccessorDeduplication
  extends IrregularDecisionTraceEventBase {
  readonly kind = 'successor_deduplication' as const
  readonly stepIndex: number
  readonly successorStateId: string
  readonly decision: 'kept' | 'dropped'
  readonly reason: 'unique_successor' | 'preferred_dedup_representative' | 'duplicate_successor'

  constructor(
    input: EventInput<{
      readonly stepIndex: number
      readonly successorStateId: string
      readonly decision: 'kept' | 'dropped'
      readonly reason:
        | 'unique_successor'
        | 'preferred_dedup_representative'
        | 'duplicate_successor'
    }>
  ) {
    super(input)
    this.stepIndex = input.stepIndex
    this.successorStateId = input.successorStateId
    this.decision = input.decision
    this.reason = input.reason
  }
}

export class IrregularDecisionTraceSuccessorLayoutScored
  extends IrregularDecisionTraceEventBase {
  readonly kind = 'successor_layout_scored' as const
  readonly stepIndex: number
  readonly state: IrregularDecisionTraceState
  readonly score: IrregularDecisionTraceLayoutScore

  constructor(
    input: EventInput<{
      readonly stepIndex: number
      readonly state: IrregularDecisionTraceState
      readonly score: IrregularDecisionTraceLayoutScore
    }>
  ) {
    super(input)
    this.stepIndex = input.stepIndex
    this.state = input.state
    this.score = input.score
  }
}

export class IrregularDecisionTraceBeamSelection extends IrregularDecisionTraceEventBase {
  readonly kind = 'beam_selection' as const
  readonly stepIndex: number
  readonly stateId: string
  readonly rank: number
  readonly decision: 'retained' | 'pruned'
  readonly reason:
    | 'within_beam_width'
    | 'protected_incumbent'
    | 'outside_beam_width'
    | 'displaced_by_protected_incumbent'

  constructor(
    input: EventInput<{
      readonly stepIndex: number
      readonly stateId: string
      readonly rank: number
      readonly decision: 'retained' | 'pruned'
      readonly reason:
        | 'within_beam_width'
        | 'protected_incumbent'
        | 'outside_beam_width'
        | 'displaced_by_protected_incumbent'
    }>
  ) {
    super(input)
    this.stepIndex = input.stepIndex
    this.stateId = input.stateId
    this.rank = input.rank
    this.decision = input.decision
    this.reason = input.reason
  }
}

export class IrregularDecisionTraceBeamStepCompleted extends IrregularDecisionTraceEventBase {
  readonly kind = 'beam_step_completed' as const
  readonly stepIndex: number
  readonly generatedCandidateCount: number
  readonly uniqueSuccessorCount: number
  readonly retainedStateCount: number

  constructor(
    input: EventInput<{
      readonly stepIndex: number
      readonly generatedCandidateCount: number
      readonly uniqueSuccessorCount: number
      readonly retainedStateCount: number
    }>
  ) {
    super(input)
    this.stepIndex = input.stepIndex
    this.generatedCandidateCount = input.generatedCandidateCount
    this.uniqueSuccessorCount = input.uniqueSuccessorCount
    this.retainedStateCount = input.retainedStateCount
  }
}

export class IrregularDecisionTraceLocalRepairAccepted
  extends IrregularDecisionTraceEventBase {
  readonly kind = 'local_repair_accepted' as const
  readonly iterationIndex: number
  readonly pieceId: string
  readonly state: IrregularDecisionTraceState
  readonly score: IrregularDecisionTraceLayoutScore

  constructor(
    input: EventInput<{
      readonly iterationIndex: number
      readonly pieceId: string
      readonly state: IrregularDecisionTraceState
      readonly score: IrregularDecisionTraceLayoutScore
    }>
  ) {
    super(input)
    this.iterationIndex = input.iterationIndex
    this.pieceId = input.pieceId
    this.state = input.state
    this.score = input.score
  }
}

export class IrregularDecisionTraceDecodeWinner extends IrregularDecisionTraceEventBase {
  readonly kind = 'decode_winner' as const
  readonly state: IrregularDecisionTraceState
  readonly score: IrregularDecisionTraceLayoutScore

  constructor(
    input: EventInput<{
      readonly state: IrregularDecisionTraceState
      readonly score: IrregularDecisionTraceLayoutScore
    }>
  ) {
    super(input)
    this.state = input.state
    this.score = input.score
  }
}

export type IrregularDecisionTraceEvent =
  | IrregularDecisionTraceDecodeStarted
  | IrregularDecisionTraceBeamStepStarted
  | IrregularDecisionTraceParentState
  | IrregularDecisionTraceEligiblePieces
  | IrregularDecisionTraceTransformCandidatesGenerated
  | IrregularDecisionTraceLocalCandidateScored
  | IrregularDecisionTraceLocalCandidateSelection
  | IrregularDecisionTraceSuccessorDeduplication
  | IrregularDecisionTraceSuccessorLayoutScored
  | IrregularDecisionTraceBeamSelection
  | IrregularDecisionTraceBeamStepCompleted
  | IrregularDecisionTraceLocalRepairAccepted
  | IrregularDecisionTraceDecodeWinner

export type EmitIrregularDecisionTrace = (event: IrregularDecisionTraceEvent) => void
