import { Data, Effect } from 'effect'
import { performance } from 'node:perf_hooks'
import type { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import type {
  IrregularPlacedPiece,
  IrregularPreparedPiece
} from '@shared/irregular/domain.js'
import {
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalEnclosedCavities,
  measureCanonicalLayoutContacts,
  measureCanonicalLayoutEnvelope,
  measureCanonicalLayoutTopology
} from '../../irregular/canonicalLayoutGeometry.js'
import { fromGrid, toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import type { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import type {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError,
  IrregularNfpIfpControl,
  NfpIfpService
} from '../../irregular/services.js'
import {
  IrregularNfpIfpControlAbortError
} from '../../irregular/services.js'
import { IrregularBeamState } from './irregularBeamState.js'
import {
  buildIntrinsicTransformCatalog,
  assertIntrinsicTargetExactLegal,
  IntrinsicExactProjectionError,
  projectIntrinsicLayoutExactly,
  type IntrinsicExactProjectionResult,
  type IntrinsicTargetBox,
  type IntrinsicTransformCatalog
} from './intrinsicExactProjection.js'
import {
  canonicalizeRelaxedState,
  evaluateIntrinsicSeparation,
  intrinsicDisruptionProposals,
  intrinsicFocusedProposals,
  intrinsicFocusedProposalsForPiece,
  intrinsicProjectionPriority,
  intrinsicRelaxedStateKey,
  provisionalLayoutFromRelaxedState,
  relaxedStateFromExactLayout,
  remapIntrinsicTransformsQuarterTurn,
  transportIntrinsicGroup,
  updateIntrinsicSeparatorWeights,
  type IntrinsicRelaxedState,
  type IntrinsicRelaxedPose,
  type IntrinsicSeparationEvaluation,
  type IntrinsicSeparatorProposal,
  type IntrinsicSeparatorWeights
} from './intrinsicTransformSeparator.js'

export const INTRINSIC_GLOBAL_SEARCH_DEFAULTS = {
  targetRoleCount: 3,
  basinCountPerRole: 2,
  sweepsPerBasin: 12,
  forcedDisruptionSweeps: [0, 4, 8] as const,
  poolCapacity: 8,
  maximumSeparationEvaluations: 200_000,
  maximumProjectionAttempts: 5,
  maximumRuntimeMs: 110_000,
  structuralHandoffCapacity: 5,
  explorationAreaCapMm2: 439_904.17,
  interfaceDisruptionMaximumCavityCount: 2,
  interfaceDisruptionMaximumHullGapRatio: 0.15,
  interfaceDisruptionStagnationSweeps: 2,
  seed: 0x4e_34_53_44
} as const

export interface IntrinsicPiecePartition {
  readonly structuralPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly fillerPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly maximumCollisionAreaMm2: number
  readonly structuralAreaThresholdMm2: number
}

export interface IntrinsicGlobalTargetRole {
  readonly id: 'e1-envelope' | 'expanded-e1-envelope' | 'four-three-cap'
  readonly widthMm: number
  readonly heightMm: number
  readonly areaMm2: number
}

export type IntrinsicDisruptionProposalKind = Extract<
  IntrinsicSeparatorProposal['kind'],
  'swap' | 'group-transport' | 'split-squeeze' | 'interface-disrupt'
>

export interface IntrinsicDisruptionLineageProvenance {
  readonly originSweep: number
  readonly originProposalKind: IntrinsicDisruptionProposalKind
  readonly originStateKey: string
  readonly depth: number
}

export interface IntrinsicLineageWitnessTrace {
  readonly stateKey: string
  readonly rawLoss: number
  readonly weightedLoss: number
  readonly originSweep: number
  readonly originProposalKind: IntrinsicDisruptionProposalKind
  readonly originStateKey: string
  readonly depth: number
}

export interface IntrinsicDirectDisruptionProposalCounts {
  readonly swap: number
  readonly groupTransport: number
  readonly splitSqueeze: number
  readonly interfaceDisrupt: number
}

export type IntrinsicPressureAxis = 'x' | 'y'
export type IntrinsicInfeasibleSearchScope = 'ordinary-e5.1' | 'contracted-pressure'

export interface IntrinsicPressureBox {
  readonly minimumXGrid: number
  readonly minimumYGrid: number
  readonly maximumXGrid: number
  readonly maximumYGrid: number
  readonly widthMm: number
  readonly heightMm: number
}

export interface IntrinsicPressureCompactnessTuple {
  readonly canonicalIdentity: string
  readonly envelopeAreaMm2: number
  readonly envelopeMaximumSideMm: number
  readonly areaWeightedCentroidDispersion: number
  readonly enclosedCavityCount: number
  readonly largestOccupiedHullGapRatio: number
}

export type IntrinsicPressureCanonicalClassification =
  | 'sat-clear-canonical-legal'
  | 'sat-clear-canonical-illegal'
  | 'sat-conflict-canonical-legal'
  | 'sat-conflict-canonical-illegal'
  | 'unmaterializable'

export interface IntrinsicPressureCanonicalLegality {
  readonly stateKey: string | undefined
  readonly satConflictCount: number
  readonly satExactZeroLoss: boolean
  readonly canonicalLegal: boolean
  readonly classification: IntrinsicPressureCanonicalClassification
}

export interface IntrinsicPressureCanonicalLegalityMemo {
  readonly byStateKey: Map<string, IntrinsicPressureCanonicalLegality>
  requestCount: number
  evaluationCount: number
  cacheHitCount: number
  disagreementCount: number
}

export interface IntrinsicPressureConflictTrace {
  readonly key: string
  readonly kind: 'pair' | 'wall'
  readonly firstPieceId: PieceId
  readonly secondPieceId: PieceId | undefined
  readonly normalizedDepth: number
  readonly rawDepth: number
  readonly weightedContribution: number
  readonly moveXGrid: number
  readonly moveYGrid: number
  readonly wallSide: 'left' | 'right' | 'bottom' | 'top' | undefined
}

export interface IntrinsicPressureLossSnapshot {
  readonly stateKey: string
  readonly parentStateKey: string | undefined
  readonly childStateKey: string
  readonly generationDepth: number
  readonly selectedPieceIds: ReadonlyArray<PieceId>
  readonly affectedPieceIds: ReadonlyArray<PieceId>
  readonly affectedPieceCount: number
  readonly lineageAffectedPieceIds: ReadonlyArray<PieceId>
  readonly lineageAffectedPieceCount: number
  readonly proposalKind: IntrinsicPressureProposalKind | undefined
  readonly rawLoss: number
  readonly weightedLoss: number
  readonly wallConflictCount: number
  readonly pairConflictCount: number
  readonly conflictedPieceCount: number
  readonly topConflicts: ReadonlyArray<IntrinsicPressureConflictTrace>
}

export interface IntrinsicPressureWeightUpdateTrace {
  readonly conflictKey: string
  readonly before: number
  readonly after: number
}

export interface IntrinsicContractedPressureSweepTrace {
  readonly sweepIndex: number
  readonly terminationReason:
    | 'continue'
    | 'deadline-before-work'
    | 'deadline-during-composite'
    | 'no-proposals'
    | 'empty-candidate-set'
    | 'raw-winner-unavailable'
    | 'evaluation-budget-exhausted'
    | 'accepted-exact-endpoint'
    | 'adaptive-non-improvement'
    | 'active-at-cap'
    | 'repair-sweep-allocation-exhausted'
  readonly startPreGls: IntrinsicPressureLossSnapshot | undefined
  readonly generatedBestPreGls: IntrinsicPressureLossSnapshot | undefined
  readonly retainedRawBestPreGls: IntrinsicPressureLossSnapshot | undefined
  readonly retainedRawBestPostGls: IntrinsicPressureLossSnapshot | undefined
  readonly retainedWeightedBestPostGls: IntrinsicPressureLossSnapshot | undefined
  readonly bestSoFarRawLoss: number
  readonly preGlsImprovementDeltaRawLoss: number
  readonly preGlsImprovementDeltaWeightedLoss: number
  readonly firstBestSweepIndex: number | undefined
  readonly consecutiveExtraNonImprovementCount: number
  readonly emittedProposalCount: number
  readonly evaluatedProposalCount: number
  readonly generatedUniqueCandidateCount: number
  readonly wholeCandidateSetUniqueCount: number | undefined
  readonly prePoolSize: number
  readonly postPoolSize: number
  readonly rawWinnerStateKey: string | undefined
  readonly rawWinnerRetained: boolean
  readonly retainedRawWinnerStateKey: string | undefined
  readonly retainedWeightedWinnerStateKey: string | undefined
  readonly glsDriverStateKey: string | undefined
  readonly weightUpdates: ReadonlyArray<IntrinsicPressureWeightUpdateTrace>
  readonly compositeParents: ReadonlyArray<IntrinsicPressureCompositeParentTrace>
}

export interface IntrinsicPressureGenerationProvenance {
  readonly parentStateKey: string | undefined
  readonly childStateKey: string
  readonly generationDepth: number
  readonly selectedPieceIds: ReadonlyArray<PieceId>
  readonly affectedPieceIds: ReadonlyArray<PieceId>
  readonly lineageAffectedPieceIds: ReadonlyArray<PieceId>
  readonly proposalKind: IntrinsicPressureProposalKind | undefined
}

export type IntrinsicPressureProposalKind =
  | IntrinsicSeparatorProposal['kind']
  | 'sequential-collider-composite'

export interface IntrinsicPressureCompositeVisitTrace {
  readonly pieceId: PieceId
  readonly outcome:
    | 'already-clear'
    | 'committed'
    | 'no-op'
    | 'canonical-legal'
    | 'evaluation-cap'
    | 'deadline'
  readonly proposalCount: number
  readonly evaluationCount: number
  readonly selectedStateKey: string | undefined
  readonly beforeRawLoss: number
  readonly beforeWeightedLoss: number
  readonly afterRawLoss: number
  readonly afterWeightedLoss: number
  readonly beforePairConflictCount: number
  readonly afterPairConflictCount: number
  readonly beforeConflictedPieceCount: number
  readonly afterConflictedPieceCount: number
  readonly canonicalLegality: IntrinsicPressureCanonicalLegality | undefined
  readonly conflictBefore: IntrinsicPressureConflictTuple
  readonly conflictAfter: IntrinsicPressureConflictTuple
  readonly candidateAccounting: ReadonlyArray<IntrinsicPressureCandidateAccounting>
  readonly candidates: ReadonlyArray<IntrinsicPressureCandidateTrace>
  readonly selectedCandidateSource: IntrinsicPressureCompositeCandidateSource
  readonly selectedCandidateOrdinal: number | undefined
  readonly selectedOrientationFamily: string | undefined
  readonly selectedTransformKey: string | undefined
  readonly selectedTranslateXGrid: number | undefined
  readonly selectedTranslateYGrid: number | undefined
}

export type IntrinsicPressureCompositeOrderIdentity =
  | 'priority-forward'
  | 'priority-reverse'

export type IntrinsicPressureCompositeCandidateSource =
  | 'no-op'
  | 'existing-separate'
  | 'existing-transform'
  | 'adaptive-transform-family'

export type IntrinsicPressureCandidatePass =
  | 'existing'
  | 'adaptive-axis-x'
  | 'adaptive-axis-y'

export interface IntrinsicPressureConflictTuple {
  readonly wallConflictCount: number
  readonly pairConflictCount: number
  readonly conflictedPieceCount: number
}

export interface IntrinsicPressureCandidateAccounting {
  readonly source: IntrinsicPressureCompositeCandidateSource
  readonly pass: IntrinsicPressureCandidatePass
  readonly generatedCount: number
  readonly materializedCount: number
  readonly legalCount: number
  readonly uniqueCount: number
  readonly evaluatedCount: number
  readonly incidentClearCount: number
  readonly globallyClearCount: number
  readonly selectedCount: number
  readonly capSkippedCount: number
}

export interface IntrinsicPressureCandidateTrace {
  readonly source: IntrinsicPressureCompositeCandidateSource
  readonly pass: IntrinsicPressureCandidatePass
  readonly ordinal: number
  readonly orientationFamily: string | undefined
  readonly stateKey: string | undefined
  readonly transformKey: string | undefined
  readonly translateXGrid: number | undefined
  readonly translateYGrid: number | undefined
  readonly conflict: IntrinsicPressureConflictTuple | undefined
  readonly incidentClear: boolean | undefined
  readonly globallyClear: boolean | undefined
  readonly rawLoss: number | undefined
  readonly weightedLoss: number | undefined
  readonly outcome:
    | 'deduplicated'
    | 'invalid'
    | 'evaluated'
    | 'selected'
    | 'cap-skipped'
}

export interface IntrinsicAdaptiveTransformFamilyCandidate {
  readonly state: IntrinsicRelaxedState
  readonly stateKey: string
  readonly source: 'adaptive-transform-family'
  readonly pass: 'adaptive-axis-x' | 'adaptive-axis-y'
  readonly ordinal: number
  readonly orientationFamily: string
  readonly transformKey: string
  readonly translateXGrid: number
  readonly translateYGrid: number
}

export interface IntrinsicAdaptiveTransformFamilyCandidateSet {
  readonly selectedAxes: ReadonlyArray<IntrinsicPressureAxis>
  readonly generatedCount: number
  readonly materializedCount: number
  readonly uniqueCount: number
  readonly candidates: ReadonlyArray<IntrinsicAdaptiveTransformFamilyCandidate>
}

export interface IntrinsicTwoRadiusRefinementCandidate {
  readonly state: IntrinsicRelaxedState
  readonly stateKey: string
  readonly source: 'refine-small' | 'refine-large'
  readonly ordinal: number
  readonly transformKey: string
  readonly translateXGrid: number
  readonly translateYGrid: number
}

export interface IntrinsicTwoRadiusRefinementCandidateSet {
  readonly invoked: true
  readonly generatedCount: 16
  readonly targetLegalCount: number
  readonly uniqueCount: number
  readonly smallRadiusGrid: number
  readonly largeRadiusGrid: number
  readonly candidates: ReadonlyArray<IntrinsicTwoRadiusRefinementCandidate>
}

export interface IntrinsicCanonicalControlResult {
  readonly referenceCanonicalIdentity: string | undefined
  readonly candidateCanonicalIdentity: string | undefined
  readonly identityMatches: boolean
  readonly pieceCoverageMatches: boolean
  readonly candidateCanonicalLegal: boolean
  readonly accepted: boolean
  readonly reason:
    | 'accepted'
    | 'reference-identity-unavailable'
    | 'candidate-identity-unavailable'
    | 'identity-mismatch'
    | 'piece-coverage-mismatch'
      | 'candidate-canonical-illegal'
}

export interface IntrinsicStructuralE1CanonicalControlTrace {
  readonly targetBox: IntrinsicTargetBox
  readonly structuralPieceCount: number
  readonly stateKey: string
  readonly satRawLoss: number
  readonly satWeightedLoss: number
  readonly satConflictCount: number
  readonly satExactZeroLoss: boolean
  readonly satConflict: IntrinsicPressureConflictTuple
  readonly canonicalControl: IntrinsicCanonicalControlResult
  readonly canonicalLegality: IntrinsicPressureCanonicalLegality
  readonly canonicalAcceptanceIndependentOfSat: boolean
  readonly separationEvaluationBudgetCost: 0
  readonly selectionEligible: false
}

export interface IntrinsicPressureCompositeParentTrace {
  readonly parentStateKey: string
  readonly compositeStateKey: string
  readonly frozenColliderIds: ReadonlyArray<PieceId>
  readonly visitedPieceIds: ReadonlyArray<PieceId>
  readonly alreadyClearPieceIds: ReadonlyArray<PieceId>
  readonly committedPieceIds: ReadonlyArray<PieceId>
  readonly skippedPieceIds: ReadonlyArray<PieceId>
  readonly frozenColliderCount: number
  readonly visitedPieceCount: number
  readonly alreadyClearPieceCount: number
  readonly committedPieceCount: number
  readonly skippedPieceCount: number
  readonly distinctAffectedPieceCount: number
  readonly visits: ReadonlyArray<IntrinsicPressureCompositeVisitTrace>
  readonly startRawLoss: number
  readonly startWeightedLoss: number
  readonly endRawLoss: number
  readonly endWeightedLoss: number
  readonly startPairConflictCount: number
  readonly endPairConflictCount: number
  readonly startConflictedPieceCount: number
  readonly endConflictedPieceCount: number
  readonly exactZeroIntermediateVisitIndex: number | undefined
  readonly canonicalLegalIntermediateVisitIndex: number | undefined
  readonly canonicalLegalityRequestCount: number
  readonly canonicalLegalityEvaluationCount: number
  readonly canonicalLegalityCacheHitCount: number
  readonly canonicalLegalityDisagreementCount: number
  readonly orderIdentity: IntrinsicPressureCompositeOrderIdentity
  readonly candidateAccounting: ReadonlyArray<IntrinsicPressureCandidateAccounting>
  readonly winnerSource: IntrinsicPressureCompositeCandidateSource
  readonly winnerStateKey: string
  readonly winnerSurvivedComposite: boolean
  readonly evaluationCount: number
  readonly evaluationCapReached: boolean
  readonly deadlineReached: boolean
  readonly emittedComposite: boolean
  readonly outerRetentionOutcome:
    | 'retained'
    | 'capacity-pruned'
    | 'not-emitted'
    | 'interrupted'
}

export interface IntrinsicSequentialColliderCompositeResult {
  readonly state: IntrinsicRelaxedState
  readonly evaluation: IntrinsicSeparationEvaluation
  readonly key: string
  readonly affectedPieceIds: ReadonlyArray<PieceId>
  readonly evaluationCount: number
  readonly exactZeroIntermediate: boolean
  readonly canonicalLegalIntermediate: boolean
  readonly evaluationCapReached: boolean
  readonly deadlineReached: boolean
  readonly trace: IntrinsicPressureCompositeParentTrace
}

export interface IntrinsicPressureCompositeChoiceScore {
  readonly stateKey: string
  readonly weightedLoss: number
  readonly rawLoss: number
}

export interface IntrinsicPressureInterruptedSweepDiagnostics {
  readonly generatedBestPreGls: IntrinsicPressureLossSnapshot | undefined
  readonly retainedRawBest: IntrinsicPressureLossSnapshot | undefined
  readonly retainedWeightedBest: IntrinsicPressureLossSnapshot | undefined
  readonly preGlsImprovementDeltaRawLoss: number
  readonly preGlsImprovementDeltaWeightedLoss: number
  readonly firstBestSweepIndex: number | undefined
  readonly rawWinnerStateKey: string | undefined
  readonly rawWinnerRetained: boolean
  readonly retainedRawWinnerStateKey: string | undefined
  readonly retainedWeightedWinnerStateKey: string | undefined
  readonly compositeParents: ReadonlyArray<IntrinsicPressureCompositeParentTrace>
}

export interface IntrinsicPressureAdaptiveDepthDecision {
  readonly consecutiveExtraNonImprovementCount: number
  readonly shouldStop: boolean
}

export interface IntrinsicContractedPressureAttemptTrace {
  readonly attemptIndex: number
  readonly ratioScheduleIndex: 0 | 1 | 2
  readonly parentCompactness: IntrinsicPressureCompactnessTuple
  readonly occupiedBox: IntrinsicPressureBox
  readonly contractedBox: IntrinsicTargetBox
  readonly contractionAxis: IntrinsicPressureAxis
  readonly contractionRatio: number
  readonly removedWidthMm: number
  readonly areaWeightedMedianGrid: number | undefined
  readonly nearPartitionPieceIds: ReadonlyArray<PieceId>
  readonly farPartitionPieceIds: ReadonlyArray<PieceId>
  readonly translatedPartitionPieceIds: ReadonlyArray<PieceId>
  readonly proposalIdentity: string | undefined
  readonly proposalRawLoss: number | undefined
  readonly proposalWeightedLoss: number | undefined
  readonly proposalDispersion: number | undefined
  readonly separationEvaluationCount: number
  readonly bestRepairedLoss: number | undefined
  readonly bestEndpointExact: boolean
  readonly bestEndpointSatExactZero: boolean
  readonly bestEndpointCanonicalClassification:
    | IntrinsicPressureCanonicalClassification
    | undefined
  readonly canonicalLegalityRequestCount: number
  readonly canonicalLegalityEvaluationCount: number
  readonly canonicalLegalityCacheHitCount: number
  readonly canonicalLegalityDisagreementCount: number
  readonly bestEndpointCompactness: IntrinsicPressureCompactnessTuple | undefined
  readonly outcome: 'accepted' | 'rejected'
  readonly reason: string
  readonly retainedPressureIdentity: string | undefined
  readonly preProjectionCompactness: IntrinsicPressureCompactnessTuple | undefined
  readonly postProjectionCompactness: IntrinsicPressureCompactnessTuple | undefined
  readonly repairSweeps: ReadonlyArray<IntrinsicContractedPressureSweepTrace>
}

export interface IntrinsicContractedPressureProposal {
  readonly state: IntrinsicRelaxedState
  readonly occupiedBox: IntrinsicPressureBox
  readonly contractedBox: IntrinsicTargetBox
  readonly contractionAxis: IntrinsicPressureAxis
  readonly contractionRatio: number
  readonly removedWidthMm: number
  readonly areaWeightedMedianGrid: number
  readonly nearPartitionPieceIds: ReadonlyArray<PieceId>
  readonly farPartitionPieceIds: ReadonlyArray<PieceId>
}

export interface IntrinsicGlobalSweepTrace {
  readonly roleId: IntrinsicGlobalTargetRole['id']
  readonly basinIndex: 0 | 1
  readonly sweepIndex: number
  readonly completedSweepCount: number
  readonly forcedDisruption: boolean
  readonly interfaceDisruptionStagnated: boolean
  readonly interfaceDisruptionProposalCount: number
  readonly poolSize: number
  readonly proposalCount: number
  readonly separationEvaluationCount: number
  readonly lowestRawLoss: number
  readonly directDisruptionProposalCounts: IntrinsicDirectDisruptionProposalCounts
  readonly preDeduplicationLineageCount: number
  readonly postDeduplicationLineageCount: number
  readonly retainedLineageCount: number
  readonly reservedLineage: IntrinsicLineageWitnessTrace | undefined
  readonly activeLineageRetentionOutcome:
    | 'lane-unavailable'
    | 'retained-by-prior-lane'
    | 'reserved-active-lineage'
    | 'capacity-evicted'
  readonly activeLineageRetentionReason: string
  readonly shadowLineageSnapshot: IntrinsicLineageWitnessTrace | undefined
  readonly shadowLineageSnapshotOutcome:
    | 'lane-unavailable'
    | 'initialized'
    | 'replaced'
    | 'retained-earlier-or-better'
    | 'retained-no-current-lineage'
  readonly shadowLineageSnapshotReason: string
  readonly retainedSearchScopes: ReadonlyArray<IntrinsicInfeasibleSearchScope>
}

export interface IntrinsicStructuralHandoffMetrics {
  readonly canonicalGeometryIdentity: string
  readonly enclosedCavityCount: number
  readonly totalEnclosedCavityAreaMm2: number
  readonly largestOccupiedHullGapRatio: number
  readonly envelopeAreaMm2: number
  readonly envelopeMaximumSideMm: number
  readonly envelopeSpanMm: number
  readonly occupiedHullWasteRatio: number
  readonly totalStructuralContacts: number
  readonly dominantStructuralContacts: number
}

export interface IntrinsicStructuralHandoff {
  readonly targetRoleId: IntrinsicGlobalTargetRole['id']
  readonly basinIndex: 0 | 1
  readonly projectionAttempt: number
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly metrics: IntrinsicStructuralHandoffMetrics
}

export interface IntrinsicStructuralHandoffDiagnostic {
  readonly canonicalGeometryIdentity: string
  readonly targetRoleId: IntrinsicGlobalTargetRole['id']
  readonly basinIndex: 0 | 1
  readonly projectionAttempt: number
  readonly metrics: IntrinsicStructuralHandoffMetrics
}

export interface IntrinsicStructuralHandoffRetentionTrace {
  readonly outcome:
    | 'retained'
    | 'duplicate-replaced'
    | 'duplicate-discarded'
    | 'capacity-pruned'
  readonly candidate: IntrinsicStructuralHandoffDiagnostic
  readonly representative: IntrinsicStructuralHandoffDiagnostic | undefined
  readonly pruned: IntrinsicStructuralHandoffDiagnostic | undefined
  readonly retainedCanonicalGeometryIdentities: ReadonlyArray<string>
}

export type IntrinsicProjectionLane =
  | 'global-raw'
  | 'global-final-gls'
  | 'contracted-pressure'
  | 'role-disruption'

export interface IntrinsicProjectionWorkItem {
  readonly lane: IntrinsicProjectionLane
  readonly requestedTargetRoleId: IntrinsicGlobalTargetRole['id'] | undefined
  readonly targetRole: IntrinsicGlobalTargetRole
  readonly basinIndex: 0 | 1
  readonly targetBox: IntrinsicTargetBox
  readonly state: IntrinsicRelaxedState
  readonly stateKey: string
  readonly evaluation: IntrinsicSeparationEvaluation
  readonly weights: IntrinsicSeparatorWeights
  readonly disruptionLineage: boolean
  readonly disruptionLineageProvenance: IntrinsicDisruptionLineageProvenance | undefined
  readonly workIdentity: string
}

export interface IntrinsicProjectionLaneTrace {
  readonly lane: IntrinsicProjectionLane
  readonly requestedTargetRoleId: IntrinsicGlobalTargetRole['id'] | undefined
  readonly outcome: 'selected' | 'lane-unavailable' | 'lane-collapsed'
  readonly workIdentity: string | undefined
  readonly collapsedIntoWorkIdentity: string | undefined
  readonly targetRoleId: IntrinsicGlobalTargetRole['id'] | undefined
  readonly basinIndex: 0 | 1 | undefined
  readonly stateKey: string | undefined
  readonly disruptionLineage: boolean | undefined
  readonly disruptionLineageProvenance: IntrinsicDisruptionLineageProvenance | undefined
  readonly rawLoss: number | undefined
  readonly weightedLoss: number | undefined
  readonly eligibleCandidateCount: number
  readonly skippedDuplicateCount: number
}

export interface IntrinsicProjectionAttemptTrace {
  readonly lane: IntrinsicProjectionLane
  readonly requestedTargetRoleId: IntrinsicGlobalTargetRole['id'] | undefined
  readonly targetRoleId: IntrinsicGlobalTargetRole['id']
  readonly basinIndex: 0 | 1
  readonly stateKey: string
  readonly disruptionLineage: boolean
  readonly disruptionLineageProvenance: IntrinsicDisruptionLineageProvenance | undefined
  readonly completedBasinCount: number
  readonly completedSweepCount: number
  readonly projectionAttempt: number
  readonly rawLoss: number
  readonly weightedLoss: number
  readonly conflictCount: number
  readonly outcome:
    | 'exact-success'
    | 'projection-exhausted'
    | 'exact-analysis'
    | 'invalid-input'
    | 'deadline'
    | 'projection-identity-mismatch'
    | 'structural-analysis-invalid'
  readonly failedPieceId: PieceId | undefined
  readonly dilationSteps: number | undefined
  readonly structuralCanonicalGeometryIdentity: string | undefined
  readonly handoffRetention?: IntrinsicStructuralHandoffRetentionTrace
}

export interface IntrinsicGlobalSearchResult {
  readonly status: 'completed' | 'deadline-fallback' | 'budget-fallback'
  readonly fullE1Fallback: ReadonlyArray<IrregularPlacedPiece>
  readonly partition: IntrinsicPiecePartition
  readonly targetRoles: ReadonlyArray<IntrinsicGlobalTargetRole>
  readonly structuralE1CanonicalControl?: IntrinsicStructuralE1CanonicalControlTrace
  readonly searchedBasinCount: number
  readonly unavailableQuarterTurnBasinCount: number
  readonly structuralHandoffs: ReadonlyArray<IntrinsicStructuralHandoff>
  readonly trace: ReadonlyArray<IntrinsicGlobalSweepTrace>
  readonly projectionLaneTrace: ReadonlyArray<IntrinsicProjectionLaneTrace>
  readonly projectionTrace: ReadonlyArray<IntrinsicProjectionAttemptTrace>
  readonly contractedPressureTrace: ReadonlyArray<IntrinsicContractedPressureAttemptTrace>
  readonly pressureRepairSweepCount: number
  readonly completedSweepCount: number
  readonly separationEvaluationCount: number
  readonly projectionAttemptCount: number
  readonly projectionSuccessCount: number
  readonly runtimeMs: number
}

export class IntrinsicGlobalSearchError extends Data.TaggedError('IntrinsicGlobalSearchError')<{
  readonly operation: 'partition' | 'initialize' | 'search' | 'archive'
  readonly message: string
}> {}

export interface IntrinsicGlobalSearchSchedule {
  readonly expectedStructuralPieceCount?: number
  readonly sweepsPerBasin: number
  readonly forcedDisruptionSweeps: ReadonlyArray<number>
  readonly poolCapacity: number
  readonly maximumSeparationEvaluations: number
  readonly maximumProjectionAttempts: number
  readonly maximumRuntimeMs: number
  readonly structuralHandoffCapacity: number
  readonly explorationAreaCapMm2: number
  readonly interfaceDisruptionMaximumCavityCount: number
  readonly interfaceDisruptionMaximumHullGapRatio: number
  readonly interfaceDisruptionStagnationSweeps: number
  readonly seed: number
}

export interface IntrinsicInfeasiblePoolEntry {
  readonly searchScope: IntrinsicInfeasibleSearchScope
  readonly state: IntrinsicRelaxedState
  readonly evaluation: IntrinsicSeparationEvaluation
  readonly key: string
  readonly disruptionLineage: boolean
  readonly disruptionLineageProvenance: IntrinsicDisruptionLineageProvenance | undefined
  readonly disruptionProtectedUntilSweep: number | undefined
  readonly pressureGeneration?: IntrinsicPressureGenerationProvenance
}

export interface IntrinsicInfeasiblePoolRetention {
  readonly pool: ReadonlyArray<IntrinsicInfeasiblePoolEntry>
  readonly preDeduplicationLineageCount: number
  readonly postDeduplicationLineageCount: number
  readonly retainedLineageCount: number
  readonly reservedLineage: IntrinsicLineageWitnessTrace | undefined
  readonly activeLineageRetentionOutcome:
    | 'lane-unavailable'
    | 'retained-by-prior-lane'
    | 'reserved-active-lineage'
    | 'capacity-evicted'
  readonly activeLineageRetentionReason: string
}

export interface IntrinsicProjectionLaneCandidate {
  readonly targetRole: IntrinsicGlobalTargetRole
  readonly basinIndex: 0 | 1
  readonly targetBox: IntrinsicTargetBox
  readonly entry: IntrinsicInfeasiblePoolEntry
  readonly weights: IntrinsicSeparatorWeights
}

export interface IntrinsicProjectionWorkSelection {
  readonly workItems: ReadonlyArray<IntrinsicProjectionWorkItem>
  readonly trace: ReadonlyArray<IntrinsicProjectionLaneTrace>
}

interface IntrinsicPressureMeasuredLayout {
  readonly compactness: IntrinsicPressureCompactnessTuple
  readonly occupiedBox: IntrinsicPressureBox
}

interface IntrinsicPressureExactEndpoint {
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  readonly state: IntrinsicRelaxedState
  readonly stateKey: string
  readonly targetBox: IntrinsicTargetBox
  readonly evaluation: IntrinsicSeparationEvaluation
  readonly weights: IntrinsicSeparatorWeights
  readonly measured: IntrinsicPressureMeasuredLayout
  readonly canonicalLegality: IntrinsicPressureCanonicalLegality
}

interface IntrinsicPressureLaneResult {
  readonly acceptedEndpoint: IntrinsicPressureExactEndpoint | undefined
  readonly trace: ReadonlyArray<IntrinsicContractedPressureAttemptTrace>
  readonly separationEvaluationCount: number
  readonly repairSweepCount: number
  readonly deadlineReached: boolean
}

interface ProjectionDependency {
  readonly project: typeof projectIntrinsicLayoutExactly
}

const productionSchedule: IntrinsicGlobalSearchSchedule = {
  ...INTRINSIC_GLOBAL_SEARCH_DEFAULTS,
  forcedDisruptionSweeps: INTRINSIC_GLOBAL_SEARCH_DEFAULTS.forcedDisruptionSweeps
}

const INTRINSIC_PRESSURE_CONTRACTION_RATIOS = [1 / 20, 1 / 40, 1 / 80] as const

/** E3's registered area partition; no positional slicing is allowed. */
export function partitionIntrinsicStructuralPieces(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): IntrinsicPiecePartition | undefined {
  const areas = pieces.map((piece) => collisionAreaMm2(piece))
  if (areas.some((area) => area === undefined)) return undefined
  const finiteAreas = areas.filter((area): area is number => area !== undefined)
  const maximumCollisionAreaMm2 = Math.max(...finiteAreas)
  if (!Number.isFinite(maximumCollisionAreaMm2) || maximumCollisionAreaMm2 <= 0) {
    return undefined
  }
  const structuralAreaThresholdMm2 = maximumCollisionAreaMm2 / 8
  const structuralPieces: IrregularPreparedPiece[] = []
  const fillerPieces: IrregularPreparedPiece[] = []
  for (const [index, piece] of pieces.entries()) {
    const area = finiteAreas[index]
    if (area === undefined) return undefined
    ;(area >= structuralAreaThresholdMm2 ? structuralPieces : fillerPieces).push(piece)
  }
  return {
    structuralPieces,
    fillerPieces,
    maximumCollisionAreaMm2,
    structuralAreaThresholdMm2
  }
}

/** Mixes the fixed schedule seed with an order-independent sheetless job identity. */
export function deriveIntrinsicGlobalOrdinalSeed(
  catalog: IntrinsicTransformCatalog,
  scheduleSeed: number
): number {
  const canonicalJobIdentity = JSON.stringify(
    catalog.entries
      .map((entry) => [
        entry.pieceId,
        entry.transforms.map((transform) => [
          transform.canonicalTransformKey,
          transform.canonicalLocalGeometryKey
        ])
      ])
      .toSorted(([firstId], [secondId]) => String(firstId).localeCompare(String(secondId)))
  )
  return hashIntrinsicSeed(`${scheduleSeed >>> 0}:${canonicalJobIdentity}`)
}

/** Three sheet-free target roles, with both dimensions floored to the collision grid. */
export function deriveIntrinsicGlobalTargetRoles(
  e1StructuralPlaced: ReadonlyArray<IrregularPlacedPiece>,
  explorationAreaCapMm2: number = INTRINSIC_GLOBAL_SEARCH_DEFAULTS.explorationAreaCapMm2
): ReadonlyArray<IntrinsicGlobalTargetRole> | undefined {
  const bounds = canonicalPlacedBounds(e1StructuralPlaced)
  if (
    bounds === undefined ||
    !Number.isFinite(explorationAreaCapMm2) ||
    explorationAreaCapMm2 <= 0
  ) {
    return undefined
  }
  const exact = targetRole('e1-envelope', bounds.widthMm, bounds.heightMm)
  const exactArea = bounds.widthMm * bounds.heightMm
  const uniformScale = Math.sqrt(explorationAreaCapMm2 / exactArea)
  const expanded = targetRole(
    'expanded-e1-envelope',
    bounds.widthMm * uniformScale,
    bounds.heightMm * uniformScale
  )
  const fourThree = targetRole(
    'four-three-cap',
    Math.sqrt((explorationAreaCapMm2 * 4) / 3),
    Math.sqrt((explorationAreaCapMm2 * 3) / 4)
  )
  if (exact === undefined || expanded === undefined || fourThree === undefined) return undefined
  return [exact, expanded, fourThree]
}

/** Fixed production E5 structural search. It never publishes transient overlap geometry. */
export function runIntrinsicSqueezeDisruptSeparate(input: {
  readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly fullE1Placed: ReadonlyArray<IrregularPlacedPiece>
  readonly control?: IrregularNfpIfpControl
}): Effect.Effect<
  IntrinsicGlobalSearchResult,
  | IntrinsicGlobalSearchError
  | IntrinsicExactProjectionError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return runIntrinsicSqueezeDisruptSeparateWithSchedule(input, productionSchedule, {
    project: projectIntrinsicLayoutExactly
  })
}

/** Deterministic reduced-budget seam for synthetic controller tests. */
export function runIntrinsicSqueezeDisruptSeparateWithSchedule(
  input: {
    readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
    readonly fullE1Placed: ReadonlyArray<IrregularPlacedPiece>
    readonly control?: IrregularNfpIfpControl
  },
  scheduleInput: IntrinsicGlobalSearchSchedule,
  dependency: ProjectionDependency
): Effect.Effect<
  IntrinsicGlobalSearchResult,
  | IntrinsicGlobalSearchError
  | IntrinsicExactProjectionError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const fullE1Fallback = [...input.fullE1Placed]
    const schedule = snapshotIntrinsicGlobalSchedule(scheduleInput)
    const startedAt = performance.now()
    const partition = partitionIntrinsicStructuralPieces(input.allPreparedPieces)
    if (
      partition === undefined ||
      (schedule.expectedStructuralPieceCount !== undefined &&
        partition.structuralPieces.length !== schedule.expectedStructuralPieceCount)
    ) {
      return yield* globalFailure(
        'partition',
        schedule.expectedStructuralPieceCount === undefined
          ? 'the E3 area partition must yield a valid structural subset.'
          : `the E3 area partition must yield exactly ${schedule.expectedStructuralPieceCount} structural pieces for this experiment assertion.`
      )
    }
    const allE1ById = new Map(
      fullE1Fallback.map((entry) => [placedPieceId(entry), entry] as const)
    )
    const preparedIds = input.allPreparedPieces.map(preparedPieceId).toSorted()
    const fallbackIds = fullE1Fallback.map(placedPieceId).toSorted()
    if (
      new Set(preparedIds).size !== preparedIds.length ||
      allE1ById.size !== input.allPreparedPieces.length ||
      fullE1Fallback.length !== input.allPreparedPieces.length ||
      !sameSortedPieceIds(preparedIds, fallbackIds) ||
      !assertSheetlessExactFallback(fullE1Fallback)
    ) {
      return yield* globalFailure(
        'initialize',
        'the immutable full E1 fallback must cover every prepared piece once and be exact-legal.'
      )
    }
    const structuralReference = partition.structuralPieces.map((piece) =>
      allE1ById.get(preparedPieceId(piece))
    )
    if (structuralReference.some((entry) => entry === undefined)) {
      return yield* globalFailure(
        'initialize',
        'the immutable E1 fallback is missing one structural piece.'
      )
    }
    const exactStructuralReference = structuralReference.filter(
      (entry): entry is IrregularPlacedPiece => entry !== undefined
    )
    const jobCatalog = yield* buildIntrinsicTransformCatalog(input.allPreparedPieces)
    const catalog = yield* buildIntrinsicTransformCatalog(partition.structuralPieces)
    const ordinalSeed = deriveIntrinsicGlobalOrdinalSeed(jobCatalog, schedule.seed)
    const initialState = relaxedStateFromExactLayout(catalog, exactStructuralReference)
    const structuralE1Bounds = canonicalPlacedBounds(exactStructuralReference)
    const targetRoles = deriveIntrinsicGlobalTargetRoles(
      fullE1Fallback,
      schedule.explorationAreaCapMm2
    )
    if (
      initialState === undefined ||
      structuralE1Bounds === undefined ||
      targetRoles === undefined ||
      targetRoles.length !== 3
    ) {
      return yield* globalFailure(
        'initialize',
        'the structural E1 state or registered target roles could not be canonicalized.'
      )
    }
    const structuralE1CanonicalControl = observeStructuralE1CanonicalControl({
      targetBox: structuralE1Bounds,
      catalog,
      state: initialState,
      referencePlaced: exactStructuralReference
    })
    if (structuralE1CanonicalControl === undefined) {
      return yield* globalFailure(
        'initialize',
        'the structural E1 canonical control witness could not be evaluated.'
      )
    }

    let separationEvaluationCount = 0
    let completedSweepCount = 0
    let projectionAttemptCount = 0
    let projectionSuccessCount = 0
    let searchedBasinCount = 0
    let scheduleStatus: IntrinsicGlobalSearchResult['status'] = 'completed'
    const trace: IntrinsicGlobalSweepTrace[] = []
    let projectionLaneTrace: ReadonlyArray<IntrinsicProjectionLaneTrace> = []
    const projectionTrace: IntrinsicProjectionAttemptTrace[] = []
    let contractedPressureTrace: ReadonlyArray<IntrinsicContractedPressureAttemptTrace> = []
    let pressureRepairSweepCount = 0
    const projectionCandidates: IntrinsicProjectionLaneCandidate[] = []
    let contractedPressureEndpoint: IntrinsicPressureExactEndpoint | undefined
    const handoffs: IntrinsicStructuralHandoff[] = []
    let completedBasinCount = 0
    const searchControl = deadlineControl(
      input.control,
      startedAt,
      schedule.maximumRuntimeMs
    )
    const quarterTurnState = remapIntrinsicTransformsQuarterTurn(catalog, initialState)
    const basinPlans = targetRoles.flatMap((role) => {
      const q0 = {
        role,
        basinIndex: 0 as const,
        targetBox: { widthMm: role.widthMm, heightMm: role.heightMm },
        basinState: initialState
      }
      return quarterTurnState === undefined
        ? [q0]
        : [
            q0,
            {
              role,
              basinIndex: 1 as const,
              targetBox: { widthMm: role.heightMm, heightMm: role.widthMm },
              basinState: quarterTurnState
            }
          ]
    })
    const unavailableQuarterTurnBasinCount =
      quarterTurnState === undefined ? targetRoles.length : 0
    if (basinPlans.length === 0) {
      return yield* globalFailure(
        'initialize',
        'the canonical q0 state did not produce any searchable basin.'
      )
    }

    const pressure = yield* runIntrinsicContractedPressureLane({
      catalog,
      initialPlaced: exactStructuralReference,
      schedule,
      control: searchControl,
      maximumAdditionalEvaluations: Math.floor(
        schedule.maximumSeparationEvaluations / 4
      )
    })
    separationEvaluationCount += pressure.separationEvaluationCount
    pressureRepairSweepCount = pressure.repairSweepCount
    contractedPressureTrace = pressure.trace
    contractedPressureEndpoint = pressure.acceptedEndpoint
    if (pressure.deadlineReached) scheduleStatus = 'deadline-fallback'
    const contractedPressureCandidate =
      contractedPressureEndpoint === undefined
        ? undefined
        : pressureProjectionCandidate(contractedPressureEndpoint, targetRoles[0])
    let contractedPressureWorkIdentity: string | undefined
    let retainedPressureHandoff: IntrinsicStructuralHandoff | undefined

    if (scheduleStatus === 'completed' && contractedPressureCandidate !== undefined) {
      const pressureWorkItem = projectionWorkItem(
        'contracted-pressure',
        undefined,
        contractedPressureCandidate
      )
      contractedPressureWorkIdentity = pressureWorkItem.workIdentity
      projectionLaneTrace = [
        {
          ...projectionLaneTraceFromWork(pressureWorkItem),
          outcome: 'selected',
          collapsedIntoWorkIdentity: undefined,
          eligibleCandidateCount: 1,
          skippedDuplicateCount: 0
        }
      ]
      const provisional = provisionalLayoutFromRelaxedState(catalog, pressureWorkItem.state)
      const reinsertionPriorityPieceIds = intrinsicProjectionPriority(
        catalog,
        pressureWorkItem.state,
        pressureWorkItem.evaluation,
        pressureWorkItem.weights
      )
      if (provisional === undefined || reinsertionPriorityPieceIds === undefined) {
        return yield* globalFailure(
          'search',
          'the accepted pressure endpoint could not be converted for exact projection.'
        )
      }
      projectionAttemptCount += 1
      const attempted = yield* Effect.matchEffect(
        dependency.project({
          targetBox: pressureWorkItem.targetBox,
          catalog,
          referencePlaced: provisional,
          provisionalPlaced: provisional,
          reinsertionPriorityPieceIds,
          control: searchControl
        }),
        {
          onFailure: (error) => Effect.succeed({ kind: 'failure' as const, error }),
          onSuccess: (value) => Effect.succeed({ kind: 'success' as const, value })
        }
      )
      const traceBase = projectionAttemptTraceBase(
        pressureWorkItem,
        completedBasinCount,
        completedSweepCount,
        projectionAttemptCount
      )
      if (attempted.kind === 'failure') {
        switch (attempted.error._tag) {
          case 'IntrinsicExactProjectionError':
            projectionTrace.push({
              ...traceBase,
              outcome: attempted.error.category,
              failedPieceId: attempted.error.failedPieceId,
              dilationSteps: attempted.error.attempts,
              structuralCanonicalGeometryIdentity: undefined
            })
            break
          case 'IrregularNfpIfpControlAbortError':
            if (attempted.error.reason === 'cancelled') {
              return yield* Effect.fail(attempted.error)
            }
            projectionTrace.push({
              ...traceBase,
              outcome: 'deadline',
              failedPieceId: undefined,
              dilationSteps: undefined,
              structuralCanonicalGeometryIdentity: undefined
            })
            scheduleStatus = 'deadline-fallback'
            break
          case 'IrregularGeometryInputError':
          case 'IrregularNestingNotImplementedError':
            return yield* Effect.fail(attempted.error)
        }
      } else {
        projectionSuccessCount += 1
        const postProjection = measureIntrinsicPressureCompactness(
          attempted.value.placedCollisionGeometries
        )
        contractedPressureTrace = recordContractedPressureProjection(
          contractedPressureTrace,
          postProjection
        )
        const projectionPreserved = pressureProjectionPreserved(
          contractedPressureEndpoint?.measured.compactness,
          postProjection?.compactness
        )
        const handoff = projectionPreserved
          ? exactStructuralHandoff({
              role: pressureWorkItem.targetRole,
              basinIndex: pressureWorkItem.basinIndex,
              projectionAttempt: projectionAttemptCount,
              targetBox: pressureWorkItem.targetBox,
              projection: attempted.value,
              expectedStructuralPieceIds: catalog.entries.map(({ pieceId }) => pieceId)
            })
          : undefined
        const handoffRetention =
          handoff === undefined
            ? undefined
            : addStructuralHandoff(handoffs, handoff, schedule.structuralHandoffCapacity)
        if (
          handoff !== undefined &&
          handoffRetention?.retainedCanonicalGeometryIdentities.includes(
            handoff.metrics.canonicalGeometryIdentity
          )
        ) {
          retainedPressureHandoff = handoff
        }
        projectionTrace.push({
          ...traceBase,
          outcome: !projectionPreserved
            ? 'projection-identity-mismatch'
            : handoff === undefined
              ? 'structural-analysis-invalid'
              : 'exact-success',
          failedPieceId: undefined,
          dilationSteps: attempted.value.dilationSteps,
          structuralCanonicalGeometryIdentity: handoff?.metrics.canonicalGeometryIdentity,
          ...(handoffRetention === undefined ? {} : { handoffRetention })
        })
      }
    }

    for (const { role, basinIndex, targetBox, basinState } of basinPlans) {
      if (scheduleStatus !== 'completed') break
      if (separationEvaluationCount >= schedule.maximumSeparationEvaluations) {
        scheduleStatus = 'budget-fallback'
        break
      }
      const initialEvaluation = evaluateIntrinsicSeparation(
        targetBox,
        catalog,
        basinState
      )
      if (initialEvaluation === undefined) {
        return yield* globalFailure('search', 'the initial separation loss was not finite.')
      }
      separationEvaluationCount += 1
      searchedBasinCount += 1
      let pool: ReadonlyArray<IntrinsicInfeasiblePoolEntry> = [
        {
          searchScope: 'ordinary-e5.1',
          state: basinState,
          evaluation: initialEvaluation,
          key: intrinsicRelaxedStateKey(catalog, basinState) ?? '',
          disruptionLineage: false,
          disruptionLineageProvenance: undefined,
          disruptionProtectedUntilSweep: undefined
        }
      ]
      let weights: IntrinsicSeparatorWeights = { byConflictKey: new Map() }
      let lowestObservedRawLoss = initialEvaluation.rawLoss
      let consecutiveNonImprovingSweeps = 0
      let shadowLineageSnapshot: IntrinsicLineageWitnessTrace | undefined

      for (let sweepIndex = 0; sweepIndex < schedule.sweepsPerBasin; sweepIndex += 1) {
        if ((yield* globalSearchCheckpoint(searchControl)) === 'deadline') {
          scheduleStatus = 'deadline-fallback'
          break
        }
        const candidates: IntrinsicInfeasiblePoolEntry[] = [...pool]
        let proposalCount = 0
        let interfaceDisruptionProposalCount = 0
        let directDisruptionProposalCounts = emptyDirectDisruptionProposalCounts()
        const forcedDisruption = schedule.forcedDisruptionSweeps.includes(sweepIndex)
        const interfaceDisruptionStagnated =
          consecutiveNonImprovingSweeps >= schedule.interfaceDisruptionStagnationSweeps
        for (const [poolIndex, entry] of pool.entries()) {
          const disruptionProposals =
            forcedDisruption
              ? intrinsicDisruptionProposals({
                  targetBox,
                  catalog,
                  state: entry.state,
                  ordinal: deterministicOrdinal(
                    ordinalSeed,
                    completedSweepCount,
                    poolIndex + 31
                  ),
                  maximumInterfaceCavityCount:
                    schedule.interfaceDisruptionMaximumCavityCount,
                  maximumInterfaceHullGapRatio:
                    schedule.interfaceDisruptionMaximumHullGapRatio,
                  interfaceDisruptionStagnated
                })
              : []
          interfaceDisruptionProposalCount += disruptionProposals.filter(
            ({ kind }) => kind === 'interface-disrupt'
          ).length
          directDisruptionProposalCounts = addDirectDisruptionProposalCounts(
            directDisruptionProposalCounts,
            disruptionProposals
          )
          const proposals = [
            ...intrinsicFocusedProposals({
              catalog,
              state: entry.state,
              evaluation: entry.evaluation,
              weights
            }),
            ...disruptionProposals
          ]
          proposalCount += proposals.length
          for (const proposal of proposals) {
            if ((yield* globalSearchCheckpoint(searchControl)) === 'deadline') {
              scheduleStatus = 'deadline-fallback'
              break
            }
            if (separationEvaluationCount >= schedule.maximumSeparationEvaluations) {
              scheduleStatus = 'budget-fallback'
              break
            }
            const evaluation = evaluateIntrinsicSeparation(
              targetBox,
              catalog,
              proposal.state,
              weights
            )
            separationEvaluationCount += 1
            const key = intrinsicRelaxedStateKey(catalog, proposal.state)
            if (evaluation !== undefined && key !== undefined) {
              const isDisruption = isIntrinsicDisruptionProposalKind(proposal.kind)
              const disruptionLineageProvenance = advanceIntrinsicDisruptionLineage(
                entry,
                proposal.kind,
                sweepIndex,
                key
              )
              candidates.push({
                searchScope: 'ordinary-e5.1',
                state: proposal.state,
                evaluation,
                key,
                disruptionLineage: disruptionLineageProvenance !== undefined,
                disruptionLineageProvenance,
                disruptionProtectedUntilSweep: isDisruption ? sweepIndex : undefined
              })
            }
          }
          if (scheduleStatus !== 'completed') break
        }
        if (scheduleStatus !== 'completed') break
        const rawBest = reweightIntrinsicPool(candidates, weights).toSorted(
          comparePoolEntriesByRaw
        )[0]
        if (rawBest === undefined) {
          return yield* globalFailure('search', 'the infeasible basin pool became empty.')
        }
        weights = updateIntrinsicSeparatorWeights(weights, rawBest.evaluation)
        const shadowUpdate = updateIntrinsicLineageShadowSnapshot(
          shadowLineageSnapshot,
          reweightIntrinsicPool(candidates, weights)
        )
        shadowLineageSnapshot = shadowUpdate.snapshot
        const retention = retainIntrinsicInfeasiblePoolWithDiagnostics(
          candidates,
          schedule.poolCapacity,
          weights,
          sweepIndex
        )
        pool = retention.pool
        const best = pool[0]
        if (best === undefined) {
          return yield* globalFailure('search', 'the reweighted basin pool became empty.')
        }
        if (best.evaluation.rawLoss < lowestObservedRawLoss) {
          lowestObservedRawLoss = best.evaluation.rawLoss
          consecutiveNonImprovingSweeps = 0
        } else {
          consecutiveNonImprovingSweeps += 1
        }
        completedSweepCount += 1
        trace.push({
          roleId: role.id,
          basinIndex,
          sweepIndex,
          completedSweepCount,
          forcedDisruption,
          interfaceDisruptionStagnated,
          interfaceDisruptionProposalCount,
          poolSize: pool.length,
          proposalCount,
          separationEvaluationCount,
          lowestRawLoss: best.evaluation.rawLoss,
          directDisruptionProposalCounts,
          preDeduplicationLineageCount: retention.preDeduplicationLineageCount,
          postDeduplicationLineageCount: retention.postDeduplicationLineageCount,
          retainedLineageCount: retention.retainedLineageCount,
          reservedLineage: retention.reservedLineage,
          activeLineageRetentionOutcome: retention.activeLineageRetentionOutcome,
          activeLineageRetentionReason: retention.activeLineageRetentionReason,
          shadowLineageSnapshot,
          shadowLineageSnapshotOutcome: shadowUpdate.outcome,
          shadowLineageSnapshotReason: shadowUpdate.reason,
          retainedSearchScopes: [...new Set(pool.map(({ searchScope }) => searchScope))]
        })
      }
      if (scheduleStatus !== 'completed') break

      completedBasinCount += 1
      projectionCandidates.push(
        ...pool.map((entry) => ({ targetRole: role, basinIndex, targetBox, entry, weights }))
      )
    }

    if (scheduleStatus === 'completed') {
      const workSelection = selectIntrinsicProjectionWorkItems(
        projectionCandidates,
        targetRoles,
        contractedPressureCandidate,
        contractedPressureWorkIdentity === undefined
          ? new Set()
          : new Set([contractedPressureWorkIdentity])
      )
      projectionLaneTrace = [...projectionLaneTrace, ...workSelection.trace]
      for (const workItem of workSelection.workItems.slice(
        0,
        Math.max(0, schedule.maximumProjectionAttempts - projectionAttemptCount)
      )) {
        if ((yield* globalSearchCheckpoint(searchControl)) === 'deadline') {
          scheduleStatus = 'deadline-fallback'
          break
        }
        const provisional = provisionalLayoutFromRelaxedState(catalog, workItem.state)
        const reinsertionPriorityPieceIds = intrinsicProjectionPriority(
          catalog,
          workItem.state,
          workItem.evaluation,
          workItem.weights
        )
        if (provisional === undefined || reinsertionPriorityPieceIds === undefined) {
          return yield* globalFailure(
            'search',
            'a selected projection lane state could not be converted for exact projection.'
          )
        }
        projectionAttemptCount += 1
        const attempted = yield* Effect.matchEffect(
          dependency.project({
            targetBox: workItem.targetBox,
            catalog,
            referencePlaced:
              workItem.lane === 'contracted-pressure'
                ? provisional
                : exactStructuralReference,
            provisionalPlaced: provisional,
            reinsertionPriorityPieceIds,
            control: searchControl
          }),
          {
            onFailure: (error) => Effect.succeed({ kind: 'failure' as const, error }),
            onSuccess: (value) => Effect.succeed({ kind: 'success' as const, value })
          }
        )
        const traceBase = projectionAttemptTraceBase(
          workItem,
          completedBasinCount,
          completedSweepCount,
          projectionAttemptCount
        )
        if (attempted.kind === 'failure') {
          switch (attempted.error._tag) {
            case 'IntrinsicExactProjectionError': {
              projectionTrace.push({
                ...traceBase,
                outcome: attempted.error.category,
                failedPieceId: attempted.error.failedPieceId,
                dilationSteps: attempted.error.attempts,
                structuralCanonicalGeometryIdentity: undefined
              })
              break
            }
            case 'IrregularNfpIfpControlAbortError':
              if (attempted.error.reason === 'cancelled') {
                return yield* Effect.fail(attempted.error)
              }
              projectionTrace.push({
                ...traceBase,
                outcome: 'deadline',
                failedPieceId: undefined,
                dilationSteps: undefined,
                structuralCanonicalGeometryIdentity: undefined
              })
              scheduleStatus = 'deadline-fallback'
              break
            case 'IrregularGeometryInputError':
            case 'IrregularNestingNotImplementedError':
              return yield* Effect.fail(attempted.error)
          }
        } else {
          projectionSuccessCount += 1
          const pressurePostProjection =
            workItem.lane === 'contracted-pressure'
              ? measureIntrinsicPressureCompactness(attempted.value.placedCollisionGeometries)
              : undefined
          if (workItem.lane === 'contracted-pressure') {
            contractedPressureTrace = recordContractedPressureProjection(
              contractedPressureTrace,
              pressurePostProjection
            )
          }
          const pressureProjectionMatches =
            workItem.lane !== 'contracted-pressure' ||
            pressureProjectionPreserved(
              contractedPressureEndpoint?.measured.compactness,
              pressurePostProjection?.compactness
            )
          const handoff = pressureProjectionMatches ? exactStructuralHandoff({
            role: workItem.targetRole,
            basinIndex: workItem.basinIndex,
            projectionAttempt: projectionAttemptCount,
            targetBox: workItem.targetBox,
            projection: attempted.value,
            expectedStructuralPieceIds: catalog.entries.map(({ pieceId }) => pieceId)
          }) : undefined
          if ((yield* globalSearchCheckpoint(searchControl)) === 'deadline') {
            scheduleStatus = 'deadline-fallback'
            break
          }
          const handoffRetention =
            handoff === undefined
              ? undefined
              : addStructuralHandoff(
                  handoffs,
                  handoff,
                  schedule.structuralHandoffCapacity
                )
          projectionTrace.push({
            ...traceBase,
            outcome:
              !pressureProjectionMatches
                ? 'projection-identity-mismatch'
                : handoff === undefined
                  ? 'structural-analysis-invalid'
                  : 'exact-success',
            failedPieceId: undefined,
            dilationSteps: attempted.value.dilationSteps,
            structuralCanonicalGeometryIdentity:
              handoff?.metrics.canonicalGeometryIdentity,
            ...(handoffRetention === undefined ? {} : { handoffRetention })
          })
        }
        if (scheduleStatus !== 'completed') break
      }
    }

    const expectedSweepCount = basinPlans.length * schedule.sweepsPerBasin
    if (scheduleStatus === 'completed' && completedSweepCount !== expectedSweepCount) {
      scheduleStatus = 'budget-fallback'
    }
    if (
      scheduleStatus === 'completed' &&
      (yield* globalSearchCheckpoint(searchControl)) === 'deadline'
    ) {
      scheduleStatus = 'deadline-fallback'
    }
    if (scheduleStatus !== 'completed') {
      handoffs.splice(0, handoffs.length)
      if (retainedPressureHandoff !== undefined) handoffs.push(retainedPressureHandoff)
    }
    return {
      status: scheduleStatus,
      fullE1Fallback,
      partition,
      targetRoles,
      structuralE1CanonicalControl,
      searchedBasinCount,
      unavailableQuarterTurnBasinCount,
      structuralHandoffs: handoffs,
      trace,
      projectionLaneTrace,
      projectionTrace,
      contractedPressureTrace,
      pressureRepairSweepCount,
      completedSweepCount,
      separationEvaluationCount,
      projectionAttemptCount,
      projectionSuccessCount,
      runtimeMs: Math.max(0, performance.now() - startedAt)
    }
  })
}

function snapshotIntrinsicGlobalSchedule(
  schedule: IntrinsicGlobalSearchSchedule
): IntrinsicGlobalSearchSchedule {
  return {
    ...(schedule.expectedStructuralPieceCount === undefined
      ? {}
      : { expectedStructuralPieceCount: schedule.expectedStructuralPieceCount }),
    sweepsPerBasin: schedule.sweepsPerBasin,
    forcedDisruptionSweeps: [...schedule.forcedDisruptionSweeps],
    poolCapacity: schedule.poolCapacity,
    maximumSeparationEvaluations: schedule.maximumSeparationEvaluations,
    maximumProjectionAttempts: schedule.maximumProjectionAttempts,
    maximumRuntimeMs: schedule.maximumRuntimeMs,
    structuralHandoffCapacity: schedule.structuralHandoffCapacity,
    explorationAreaCapMm2: schedule.explorationAreaCapMm2,
    interfaceDisruptionMaximumCavityCount:
      schedule.interfaceDisruptionMaximumCavityCount,
    interfaceDisruptionMaximumHullGapRatio:
      schedule.interfaceDisruptionMaximumHullGapRatio,
    interfaceDisruptionStagnationSweeps: schedule.interfaceDisruptionStagnationSweeps,
    seed: schedule.seed
  }
}

function exactStructuralHandoff(input: {
  readonly role: IntrinsicGlobalTargetRole
  readonly basinIndex: 0 | 1
  readonly projectionAttempt: number
  readonly targetBox: IntrinsicTargetBox
  readonly projection: IntrinsicExactProjectionResult
  readonly expectedStructuralPieceIds: ReadonlyArray<PieceId>
}): IntrinsicStructuralHandoff | undefined {
  const sheet = new SheetSpec({
    width: Math.ceil(input.targetBox.widthMm),
    height: Math.ceil(input.targetBox.heightMm),
    label: 'intrinsic-global-structural-projection'
  })
  const placed = input.projection.placedCollisionGeometries
  const actualPieceIds = placed.map(placedPieceId).toSorted()
  const expectedPieceIds = [...input.expectedStructuralPieceIds].toSorted()
  if (
    new Set(actualPieceIds).size !== actualPieceIds.length ||
    !sameSortedPieceIds(expectedPieceIds, actualPieceIds) ||
    !assertCanonicalGridLegalLayout(sheet, placed) ||
    !assertIntrinsicTargetExactLegal(input.targetBox, placed)
  ) {
    return undefined
  }
  const identity = canonicalCollisionLayoutIdentity(placed)
  const topology = measureCanonicalLayoutTopology(placed)
  const cavities = measureCanonicalEnclosedCavities(placed)
  const contacts = measureCanonicalLayoutContacts(placed)
  const envelope = measureCanonicalLayoutEnvelope(placed)
  if (
    identity === undefined ||
    topology === undefined ||
    cavities === undefined ||
    contacts === undefined ||
    envelope === undefined
  ) {
    return undefined
  }
  if (
    ![
      cavities.count,
      cavities.totalAreaMm2,
      topology.largestOccupiedHullGapRatio,
      envelope.areaMm2,
      envelope.maximumSideMm,
      envelope.spanMm,
      envelope.occupiedHullWasteRatio,
      contacts.totalStructuralContacts,
      contacts.dominantStructuralContacts
    ].every(Number.isFinite)
  ) {
    return undefined
  }
  return {
    targetRoleId: input.role.id,
    basinIndex: input.basinIndex,
    projectionAttempt: input.projectionAttempt,
    placedCollisionGeometries: placed,
    metrics: {
      canonicalGeometryIdentity: identity,
      enclosedCavityCount: cavities.count,
      totalEnclosedCavityAreaMm2: cavities.totalAreaMm2,
      largestOccupiedHullGapRatio: topology.largestOccupiedHullGapRatio,
      envelopeAreaMm2: envelope.areaMm2,
      envelopeMaximumSideMm: envelope.maximumSideMm,
      envelopeSpanMm: envelope.spanMm,
      occupiedHullWasteRatio: envelope.occupiedHullWasteRatio,
      totalStructuralContacts: contacts.totalStructuralContacts,
      dominantStructuralContacts: contacts.dominantStructuralContacts
    }
  }
}

function runIntrinsicContractedPressureLane(input: {
  readonly catalog: IntrinsicTransformCatalog
  readonly initialPlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly schedule: IntrinsicGlobalSearchSchedule
  readonly control: IrregularNfpIfpControl
  readonly maximumAdditionalEvaluations: number
}): Effect.Effect<
  IntrinsicPressureLaneResult,
  IrregularNfpIfpControlAbortError
> {
  return Effect.gen(function* () {
    const anchoredInitial = bottomLeftAnchoredPressureLayout(input.initialPlaced)
    const initialMeasured =
      anchoredInitial === undefined
        ? undefined
        : measureIntrinsicPressureCompactness(anchoredInitial)
    if (anchoredInitial === undefined || initialMeasured === undefined) {
      return {
        acceptedEndpoint: undefined,
        trace: [],
        separationEvaluationCount: 0,
        repairSweepCount: 0,
        deadlineReached: false
      }
    }

    let incumbentPlaced = anchoredInitial
    let incumbentMeasured = initialMeasured
    let acceptedEndpoint: IntrinsicPressureExactEndpoint | undefined
    let ratioCursor = 0
    let attemptIndex = 0
    let separationEvaluationCount = 0
    let repairSweepCount = 0
    const trace: IntrinsicContractedPressureAttemptTrace[] = []

    while (attemptIndex < INTRINSIC_PRESSURE_CONTRACTION_RATIOS.length) {
      if ((yield* globalSearchCheckpoint(input.control)) === 'deadline') {
        return {
          acceptedEndpoint,
          trace,
          separationEvaluationCount,
          repairSweepCount,
          deadlineReached: true
        }
      }
      const pressureStep = intrinsicPressureContractionStep(ratioCursor)
      if (pressureStep === undefined) break
      const { ratioScheduleIndex, contractionRatio } = pressureStep
      const parentMeasured = incumbentMeasured
      const proposal = deriveIntrinsicContractedPressureProposal(
        input.catalog,
        incumbentPlaced,
        contractionRatio
      )
      if (proposal === undefined) {
        trace.push(
          unavailableContractedPressureAttemptTrace({
            attemptIndex,
            ratioScheduleIndex,
            contractionRatio,
            parent: parentMeasured,
            retainedPressureIdentity:
              acceptedEndpoint?.measured.compactness.canonicalIdentity,
            reason: 'the contracted target or area-weighted median split was unavailable'
          })
        )
        ratioCursor += 1
        attemptIndex += 1
        continue
      }

      const proposalPlaced = provisionalLayoutFromRelaxedState(
        input.catalog,
        proposal.state
      )
      const proposalIdentity =
        proposalPlaced === undefined
          ? undefined
          : canonicalCollisionLayoutIdentity(proposalPlaced)
      const proposalDispersion =
        proposalPlaced === undefined
          ? undefined
          : measureIntrinsicAreaWeightedCentroidDispersion(proposalPlaced)
      if (
        separationEvaluationCount >= input.maximumAdditionalEvaluations ||
        proposalPlaced === undefined
      ) {
        trace.push(
          contractedPressureAttemptTrace({
            attemptIndex,
            ratioScheduleIndex,
            proposal,
            parent: parentMeasured,
            proposalIdentity,
            proposalEvaluation: undefined,
            proposalDispersion,
            evaluationCount: 0,
            bestRepairedLoss: undefined,
            bestEndpoint: undefined,
            outcome: 'rejected',
            reason:
              proposalPlaced === undefined
                ? 'the translated pressure state could not be materialized'
                : 'the shared separation-evaluation budget was exhausted',
            retainedPressureIdentity:
              acceptedEndpoint?.measured.compactness.canonicalIdentity,
            preProjectionCompactness: undefined
          })
        )
        ratioCursor += 1
        attemptIndex += 1
        continue
      }

      const initialEvaluation = evaluateIntrinsicSeparation(
        proposal.contractedBox,
        input.catalog,
        proposal.state
      )
      separationEvaluationCount += 1
      if (initialEvaluation === undefined) {
        trace.push(
          contractedPressureAttemptTrace({
            attemptIndex,
            ratioScheduleIndex,
            proposal,
            parent: parentMeasured,
            proposalIdentity,
            proposalEvaluation: undefined,
            proposalDispersion,
            evaluationCount: 1,
            bestRepairedLoss: undefined,
            bestEndpoint: undefined,
            outcome: 'rejected',
            reason: 'the translated pressure state produced a non-finite separation loss',
            retainedPressureIdentity:
              acceptedEndpoint?.measured.compactness.canonicalIdentity,
            preProjectionCompactness: undefined
          })
        )
        ratioCursor += 1
        attemptIndex += 1
        continue
      }

      const canonicalLegalityMemo = createIntrinsicPressureCanonicalLegalityMemo()
      let weights: IntrinsicSeparatorWeights = { byConflictKey: new Map() }
      let pool: ReadonlyArray<IntrinsicInfeasiblePoolEntry> = [
        pressurePoolEntry(
          proposal.state,
          initialEvaluation,
          intrinsicRelaxedStateKey(input.catalog, proposal.state)
        )
      ].filter((entry): entry is IntrinsicInfeasiblePoolEntry => entry !== undefined)
      const exactEndpoints: IntrinsicPressureExactEndpoint[] = []
      addExactPressureEndpoint(
        exactEndpoints,
        pressureEndpointFromState({
          catalog: input.catalog,
          targetBox: proposal.contractedBox,
          state: proposal.state,
          evaluation: initialEvaluation,
          weights,
          canonicalLegalityMemo
        })
      )
      let attemptEvaluationCount = 1
      let bestRepairedLoss = initialEvaluation.rawLoss
      let firstBestSweepIndex: number | undefined
      let budgetExhausted = false
      const repairSweeps: IntrinsicContractedPressureSweepTrace[] = []
      const mandatoryRepairSweepCount = pressureRepairSweepAllowance(
        input.schedule.sweepsPerBasin,
        attemptIndex
      )
      const maximumRepairSweepCount = mandatoryRepairSweepCount

      for (
        let repairSweep = 0;
        repairSweep < maximumRepairSweepCount &&
        !exactEndpoints.some(
          (endpoint) =>
            pressureEndpointRejectionReason(parentMeasured, endpoint) === undefined
        );
        repairSweep += 1
      ) {
        if ((yield* globalSearchCheckpoint(input.control)) === 'deadline') {
          repairSweeps.push({
            sweepIndex: repairSweep,
            terminationReason: 'deadline-before-work',
            startPreGls: undefined,
            generatedBestPreGls: undefined,
            retainedRawBestPreGls: undefined,
            retainedRawBestPostGls: undefined,
            retainedWeightedBestPostGls: undefined,
            bestSoFarRawLoss: bestRepairedLoss,
            preGlsImprovementDeltaRawLoss: 0,
            preGlsImprovementDeltaWeightedLoss: 0,
            firstBestSweepIndex,
            consecutiveExtraNonImprovementCount: 0,
            emittedProposalCount: 0,
            evaluatedProposalCount: 0,
            generatedUniqueCandidateCount: 0,
            wholeCandidateSetUniqueCount: undefined,
            prePoolSize: pool.length,
            postPoolSize: pool.length,
            rawWinnerStateKey: undefined,
            rawWinnerRetained: false,
            retainedRawWinnerStateKey: undefined,
            retainedWeightedWinnerStateKey: undefined,
            glsDriverStateKey: undefined,
            weightUpdates: [],
            compositeParents: []
          })
          const bestEndpoint = exactEndpoints.toSorted(comparePressureEndpoints)[0]
          trace.push(
            contractedPressureAttemptTrace({
              attemptIndex,
              ratioScheduleIndex,
              proposal,
              parent: parentMeasured,
              proposalIdentity,
              proposalEvaluation: initialEvaluation,
              proposalDispersion,
              evaluationCount: attemptEvaluationCount,
              bestRepairedLoss,
              bestEndpoint,
              outcome: 'rejected',
              reason: 'the cooperative runtime deadline interrupted pressure repair',
              retainedPressureIdentity:
                acceptedEndpoint?.measured.compactness.canonicalIdentity,
              preProjectionCompactness: undefined,
              canonicalLegalityMemo,
              repairSweeps
            })
          )
          return {
            acceptedEndpoint,
            trace,
            separationEvaluationCount,
            repairSweepCount,
            deadlineReached: true
          }
        }
        repairSweepCount += 1
        const prePoolSize = pool.length
        const startEntry = pool.toSorted(comparePoolEntriesByRaw)[0]
        const startPreGls = pressureLossSnapshot(startEntry, weights)
        const bestRawLossBeforeSweep = bestRepairedLoss
        const candidates: IntrinsicInfeasiblePoolEntry[] = [...pool]
        const generatedCandidates: IntrinsicInfeasiblePoolEntry[] = []
        let compositeParents: IntrinsicPressureCompositeParentTrace[] = []
        let emittedProposalCount = 0
        let evaluatedProposalCount = 0
        let deadlineInterrupted = false
        let canonicalLegalIntermediate = false
        for (const entry of pool) {
          for (const orderIdentity of [
            'priority-forward',
            'priority-reverse'
          ] as const) {
            const composite = yield* runIntrinsicSequentialColliderComposite({
              targetBox: proposal.contractedBox,
              catalog: input.catalog,
              parentState: entry.state,
              parentEvaluation: entry.evaluation,
              parentStateKey: entry.key,
              weights,
              maximumEvaluations: Math.max(
                0,
                input.maximumAdditionalEvaluations - separationEvaluationCount
              ),
              control: input.control,
              canonicalLegalityMemo,
              orderIdentity
            })
            compositeParents.push(composite.trace)
            separationEvaluationCount += composite.evaluationCount
            attemptEvaluationCount += composite.evaluationCount
            evaluatedProposalCount += composite.evaluationCount
            emittedProposalCount += composite.trace.visits.reduce(
              (count, visit) => count + Math.max(0, visit.proposalCount - 1),
              0
            )
            if (composite.evaluationCapReached) budgetExhausted = true
            if (composite.deadlineReached) deadlineInterrupted = true
            if (composite.trace.emittedComposite) {
              const entryCandidate = pressurePoolEntry(
                composite.state,
                composite.evaluation,
                composite.key,
                {
                  parentStateKey: entry.key,
                  generationDepth:
                    (entry.pressureGeneration?.generationDepth ?? 0) + 1,
                  selectedPieceIds: composite.affectedPieceIds,
                  affectedPieceIds: composite.affectedPieceIds,
                  lineageAffectedPieceIds: mergePressurePieceIds(
                    entry.pressureGeneration?.lineageAffectedPieceIds ?? [],
                    composite.affectedPieceIds
                  ),
                  proposalKind: 'sequential-collider-composite'
                }
              )
              if (entryCandidate !== undefined) {
                candidates.push(entryCandidate)
                generatedCandidates.push(entryCandidate)
                bestRepairedLoss = Math.min(
                  bestRepairedLoss,
                  composite.evaluation.rawLoss
                )
                addExactPressureEndpoint(
                  exactEndpoints,
                  pressureEndpointFromState({
                    catalog: input.catalog,
                    targetBox: proposal.contractedBox,
                    state: composite.state,
                    evaluation: composite.evaluation,
                    weights,
                    canonicalLegalityMemo
                  })
                )
              }
            }
            canonicalLegalIntermediate = composite.canonicalLegalIntermediate
            if (
              budgetExhausted ||
              deadlineInterrupted ||
              canonicalLegalIntermediate
            ) {
              break
            }
          }
          if (budgetExhausted || deadlineInterrupted || canonicalLegalIntermediate) break
        }
        if (deadlineInterrupted) {
          const interruptedDiagnostics = diagnoseIntrinsicPressureInterruptedSweep({
            pool,
            candidates,
            generatedCandidates,
            weights,
            startPreGls,
            bestRawLossBeforeSweep,
            bestRepairedLoss,
            repairSweep,
            firstBestSweepIndex,
            compositeParents
          })
          firstBestSweepIndex = interruptedDiagnostics.firstBestSweepIndex
          compositeParents = [...interruptedDiagnostics.compositeParents]
          repairSweeps.push({
            sweepIndex: repairSweep,
            terminationReason: 'deadline-during-composite',
            startPreGls,
            generatedBestPreGls: interruptedDiagnostics.generatedBestPreGls,
            retainedRawBestPreGls: interruptedDiagnostics.retainedRawBest,
            retainedRawBestPostGls: interruptedDiagnostics.retainedRawBest,
            retainedWeightedBestPostGls:
              interruptedDiagnostics.retainedWeightedBest,
            bestSoFarRawLoss: bestRepairedLoss,
            preGlsImprovementDeltaRawLoss:
              interruptedDiagnostics.preGlsImprovementDeltaRawLoss,
            preGlsImprovementDeltaWeightedLoss:
              interruptedDiagnostics.preGlsImprovementDeltaWeightedLoss,
            firstBestSweepIndex,
            consecutiveExtraNonImprovementCount: 0,
            emittedProposalCount,
            evaluatedProposalCount,
            generatedUniqueCandidateCount: new Set(
              generatedCandidates.map(({ key }) => key)
            ).size,
            wholeCandidateSetUniqueCount: new Set(
              candidates.map(({ key }) => key)
            ).size,
            prePoolSize,
            postPoolSize: pool.length,
            rawWinnerStateKey: interruptedDiagnostics.rawWinnerStateKey,
            rawWinnerRetained: interruptedDiagnostics.rawWinnerRetained,
            retainedRawWinnerStateKey:
              interruptedDiagnostics.retainedRawWinnerStateKey,
            retainedWeightedWinnerStateKey:
              interruptedDiagnostics.retainedWeightedWinnerStateKey,
            glsDriverStateKey: undefined,
            weightUpdates: [],
            compositeParents
          })
          const bestEndpoint = exactEndpoints.toSorted(comparePressureEndpoints)[0]
          trace.push(
            contractedPressureAttemptTrace({
              attemptIndex,
              ratioScheduleIndex,
              proposal,
              parent: parentMeasured,
              proposalIdentity,
              proposalEvaluation: initialEvaluation,
              proposalDispersion,
              evaluationCount: attemptEvaluationCount,
              bestRepairedLoss,
              bestEndpoint,
              outcome: 'rejected',
              reason: 'the cooperative runtime deadline interrupted composite pressure repair',
              retainedPressureIdentity:
                acceptedEndpoint?.measured.compactness.canonicalIdentity,
              preProjectionCompactness: undefined,
              canonicalLegalityMemo,
              repairSweeps
            })
          )
          return {
            acceptedEndpoint,
            trace,
            separationEvaluationCount,
            repairSweepCount,
            deadlineReached: true
          }
        }
        if (bestRepairedLoss < bestRawLossBeforeSweep) {
          firstBestSweepIndex = repairSweep
        }
        const generatedUniqueCandidateCount = new Set(
          generatedCandidates.map(({ key }) => key)
        ).size
        const wholeCandidateSetUniqueCount = new Set(
          candidates.map(({ key }) => key)
        ).size
        if (emittedProposalCount === 0 || candidates.length === 0) {
          const generatedBestPreGls = pressureLossSnapshot(
            generatedCandidates.toSorted(comparePoolEntriesByRaw)[0],
            weights
          )
          const retainedWeightedBest = pool.toSorted(comparePoolEntriesByWeight)[0]
          const preGlsImprovement = pressureSweepLocalImprovement(
            startPreGls,
            generatedBestPreGls
          )
          repairSweeps.push({
            sweepIndex: repairSweep,
            terminationReason:
              emittedProposalCount === 0 ? 'no-proposals' : 'empty-candidate-set',
            startPreGls,
            generatedBestPreGls,
            retainedRawBestPreGls: startPreGls,
            retainedRawBestPostGls: startPreGls,
            retainedWeightedBestPostGls: pressureLossSnapshot(
              retainedWeightedBest,
              weights
            ),
            bestSoFarRawLoss: bestRepairedLoss,
            preGlsImprovementDeltaRawLoss: preGlsImprovement.rawLoss,
            preGlsImprovementDeltaWeightedLoss: preGlsImprovement.weightedLoss,
            firstBestSweepIndex,
            consecutiveExtraNonImprovementCount: 0,
            emittedProposalCount,
            evaluatedProposalCount,
            generatedUniqueCandidateCount,
            wholeCandidateSetUniqueCount,
            prePoolSize,
            postPoolSize: prePoolSize,
            rawWinnerStateKey: startEntry?.key,
            rawWinnerRetained: startEntry !== undefined,
            retainedRawWinnerStateKey: startEntry?.key,
            retainedWeightedWinnerStateKey: retainedWeightedBest?.key,
            glsDriverStateKey: undefined,
            weightUpdates: [],
            compositeParents
          })
          break
        }
        const rawBest = reweightIntrinsicPool(candidates, weights).toSorted(
          comparePoolEntriesByRaw
        )[0]
        if (rawBest === undefined) {
          const generatedBestPreGls = pressureLossSnapshot(
            generatedCandidates.toSorted(comparePoolEntriesByRaw)[0],
            weights
          )
          const retainedWeightedBest = pool.toSorted(comparePoolEntriesByWeight)[0]
          const preGlsImprovement = pressureSweepLocalImprovement(
            startPreGls,
            generatedBestPreGls
          )
          repairSweeps.push({
            sweepIndex: repairSweep,
            terminationReason: 'raw-winner-unavailable',
            startPreGls,
            generatedBestPreGls,
            retainedRawBestPreGls: startPreGls,
            retainedRawBestPostGls: startPreGls,
            retainedWeightedBestPostGls: pressureLossSnapshot(
              retainedWeightedBest,
              weights
            ),
            bestSoFarRawLoss: bestRepairedLoss,
            preGlsImprovementDeltaRawLoss: preGlsImprovement.rawLoss,
            preGlsImprovementDeltaWeightedLoss: preGlsImprovement.weightedLoss,
            firstBestSweepIndex,
            consecutiveExtraNonImprovementCount: 0,
            emittedProposalCount,
            evaluatedProposalCount,
            generatedUniqueCandidateCount,
            wholeCandidateSetUniqueCount,
            prePoolSize,
            postPoolSize: prePoolSize,
            rawWinnerStateKey: undefined,
            rawWinnerRetained: false,
            retainedRawWinnerStateKey: startEntry?.key,
            retainedWeightedWinnerStateKey: retainedWeightedBest?.key,
            glsDriverStateKey: undefined,
            weightUpdates: [],
            compositeParents
          })
          break
        }
        const previousWeights = weights
        weights = updateIntrinsicSeparatorWeights(weights, rawBest.evaluation)
        pool = retainIntrinsicInfeasiblePool(
          candidates,
          input.schedule.poolCapacity,
          weights,
          repairSweep
        )
        compositeParents = compositeParents.map((parentTrace) => ({
          ...parentTrace,
          winnerSurvivedComposite:
            parentTrace.emittedComposite &&
            pool.some(({ key }) => key === parentTrace.compositeStateKey),
          outerRetentionOutcome:
            !parentTrace.emittedComposite
              ? parentTrace.outerRetentionOutcome
              : pool.some(({ key }) => key === parentTrace.compositeStateKey)
                ? 'retained'
                : 'capacity-pruned'
        }))
        const weightUpdates = pressureWeightUpdates(previousWeights, weights)
        const retainedRawBestPreGlsEntry = reweightIntrinsicPool(
          pool,
          previousWeights
        ).toSorted(comparePoolEntriesByRaw)[0]
        const retainedRawBestPostGlsEntry = pool.toSorted(comparePoolEntriesByRaw)[0]
        const retainedWeightedBest = pool.toSorted(comparePoolEntriesByWeight)[0]
        const generatedBestPreGls = pressureLossSnapshot(
          generatedCandidates.toSorted(comparePoolEntriesByRaw)[0],
          previousWeights
        )
        const retainedRawBestPreGls = pressureLossSnapshot(
          retainedRawBestPreGlsEntry,
          previousWeights
        )
        const retainedRawBestPostGls = pressureLossSnapshot(
          retainedRawBestPostGlsEntry,
          weights
        )
        const retainedWeightedBestPostGls = pressureLossSnapshot(
          retainedWeightedBest,
          weights
        )
        const preGlsImprovement = pressureSweepLocalImprovement(
          startPreGls,
          generatedBestPreGls
        )
        const acceptedEndpointReached = exactEndpoints.some(
          (endpoint) =>
            pressureEndpointRejectionReason(parentMeasured, endpoint) === undefined
        )
        const terminationReason: IntrinsicContractedPressureSweepTrace['terminationReason'] =
          budgetExhausted
            ? 'evaluation-budget-exhausted'
            : acceptedEndpointReached
              ? 'accepted-exact-endpoint'
              : repairSweep + 1 >= maximumRepairSweepCount
                ? 'repair-sweep-allocation-exhausted'
                : 'continue'
        repairSweeps.push({
          sweepIndex: repairSweep,
          terminationReason,
          startPreGls,
          generatedBestPreGls,
          retainedRawBestPreGls,
          retainedRawBestPostGls,
          retainedWeightedBestPostGls,
          bestSoFarRawLoss: bestRepairedLoss,
          preGlsImprovementDeltaRawLoss: preGlsImprovement.rawLoss,
          preGlsImprovementDeltaWeightedLoss: preGlsImprovement.weightedLoss,
          firstBestSweepIndex,
          consecutiveExtraNonImprovementCount: 0,
          emittedProposalCount,
          evaluatedProposalCount,
          generatedUniqueCandidateCount,
          wholeCandidateSetUniqueCount,
          prePoolSize,
          postPoolSize: pool.length,
          rawWinnerStateKey: rawBest.key,
          rawWinnerRetained: pool.some(({ key }) => key === rawBest.key),
          retainedRawWinnerStateKey: retainedRawBestPostGlsEntry?.key,
          retainedWeightedWinnerStateKey: retainedWeightedBest?.key,
          glsDriverStateKey: rawBest.key,
          weightUpdates,
          compositeParents
        })
        if (budgetExhausted) break
      }

      const rankedEndpoints = exactEndpoints.toSorted(comparePressureEndpoints)
      const accepted = rankedEndpoints.find(
        (endpoint) => pressureEndpointRejectionReason(parentMeasured, endpoint) === undefined
      )
      const bestEndpoint = accepted ?? rankedEndpoints[0]
      const reason =
        accepted === undefined
          ? pressureEndpointRejectionReason(parentMeasured, bestEndpoint) ??
            (budgetExhausted
              ? 'the shared separation-evaluation budget was exhausted before an exact endpoint'
              : 'the separator produced no canonical-exact endpoint')
          : 'the canonical-exact endpoint strictly improved every registered pressure metric'
      if (accepted !== undefined) {
        for (let index = 0; index < trace.length; index += 1) {
          const existing = trace[index]
          if (existing?.preProjectionCompactness !== undefined) {
            trace[index] = { ...existing, preProjectionCompactness: undefined }
          }
        }
        incumbentPlaced = accepted.placed
        incumbentMeasured = accepted.measured
        acceptedEndpoint = accepted
      }
      trace.push(
        contractedPressureAttemptTrace({
          attemptIndex,
          ratioScheduleIndex,
          proposal,
          parent: parentMeasured,
          proposalIdentity,
          proposalEvaluation: initialEvaluation,
          proposalDispersion,
          evaluationCount: attemptEvaluationCount,
          bestRepairedLoss,
          bestEndpoint,
          outcome: accepted === undefined ? 'rejected' : 'accepted',
          reason,
          retainedPressureIdentity:
            acceptedEndpoint?.measured.compactness.canonicalIdentity,
          preProjectionCompactness: accepted?.measured.compactness,
          canonicalLegalityMemo,
          repairSweeps
        })
      )
      ratioCursor = accepted === undefined ? ratioCursor + 1 : 0
      attemptIndex += 1
    }

    return {
      acceptedEndpoint,
      trace,
      separationEvaluationCount,
      repairSweepCount,
      deadlineReached: false
    }
  })
}

export function deriveIntrinsicContractedPressureProposal(
  catalog: IntrinsicTransformCatalog,
  placed: ReadonlyArray<IrregularPlacedPiece>,
  contractionRatio: number
): IntrinsicContractedPressureProposal | undefined {
  if (!Number.isFinite(contractionRatio) || contractionRatio <= 0 || contractionRatio >= 1) {
    return undefined
  }
  const anchored = bottomLeftAnchoredPressureLayout(placed)
  if (anchored === undefined) return undefined
  const state = relaxedStateFromExactLayout(catalog, anchored)
  const occupiedBox = canonicalPressureBox(anchored)
  const moments = canonicalPlacedPolygonMoments(anchored)
  if (state === undefined || occupiedBox === undefined || moments === undefined) {
    return undefined
  }
  const contractionAxis: IntrinsicPressureAxis =
    occupiedBox.widthMm >= occupiedBox.heightMm ? 'x' : 'y'
  const occupiedSpanGrid =
    contractionAxis === 'x'
      ? occupiedBox.maximumXGrid - occupiedBox.minimumXGrid
      : occupiedBox.maximumYGrid - occupiedBox.minimumYGrid
  const removedWidthGrid = Math.max(1, Math.floor(occupiedSpanGrid * contractionRatio))
  const contractedSpanGrid = occupiedSpanGrid - removedWidthGrid
  if (contractedSpanGrid <= 0) return undefined
  const ranked = moments.toSorted((first, second) => {
    const firstCoordinate = contractionAxis === 'x' ? first.centroidXGrid : first.centroidYGrid
    const secondCoordinate = contractionAxis === 'x' ? second.centroidXGrid : second.centroidYGrid
    return firstCoordinate - secondCoordinate || first.pieceId.localeCompare(second.pieceId)
  })
  const totalArea = ranked.reduce((sum, entry) => sum + entry.areaGrid2, 0)
  let cumulativeArea = 0
  let medianIndex = -1
  for (const [index, entry] of ranked.entries()) {
    cumulativeArea += entry.areaGrid2
    if (cumulativeArea >= totalArea / 2) {
      medianIndex = index
      break
    }
  }
  const median = ranked[medianIndex]
  const nearPartition = ranked.slice(0, medianIndex + 1)
  const farPartition = ranked.slice(medianIndex + 1)
  if (median === undefined || nearPartition.length === 0 || farPartition.length === 0) {
    return undefined
  }
  const translated = transportIntrinsicGroup(
    catalog,
    state,
    farPartition.map(({ pieceId }) => pieceId),
    contractionAxis === 'x'
      ? { x: -removedWidthGrid, y: 0 }
      : { x: 0, y: -removedWidthGrid }
  )
  if (translated === undefined) return undefined
  return {
    state: translated,
    occupiedBox,
    contractedBox:
      contractionAxis === 'x'
        ? { widthMm: fromGrid(contractedSpanGrid), heightMm: occupiedBox.heightMm }
        : { widthMm: occupiedBox.widthMm, heightMm: fromGrid(contractedSpanGrid) },
    contractionAxis,
    contractionRatio,
    removedWidthMm: fromGrid(removedWidthGrid),
    areaWeightedMedianGrid:
      contractionAxis === 'x' ? median.centroidXGrid : median.centroidYGrid,
    nearPartitionPieceIds: nearPartition.map(({ pieceId }) => pieceId),
    farPartitionPieceIds: farPartition.map(({ pieceId }) => pieceId)
  }
}

export function measureIntrinsicPressureCompactness(
  placed: ReadonlyArray<IrregularPlacedPiece>
): IntrinsicPressureMeasuredLayout | undefined {
  const canonicalIdentity = canonicalCollisionLayoutIdentity(placed)
  const occupiedBox = canonicalPressureBox(placed)
  const dispersion = measureIntrinsicAreaWeightedCentroidDispersion(placed)
  const cavities = measureCanonicalEnclosedCavities(placed)
  const topology = measureCanonicalLayoutTopology(placed)
  if (
    canonicalIdentity === undefined ||
    occupiedBox === undefined ||
    dispersion === undefined ||
    cavities === undefined ||
    topology === undefined
  ) {
    return undefined
  }
  const envelopeAreaMm2 = occupiedBox.widthMm * occupiedBox.heightMm
  return {
    occupiedBox,
    compactness: {
      canonicalIdentity,
      envelopeAreaMm2,
      envelopeMaximumSideMm: Math.max(occupiedBox.widthMm, occupiedBox.heightMm),
      areaWeightedCentroidDispersion: dispersion,
      enclosedCavityCount: cavities.count,
      largestOccupiedHullGapRatio: topology.largestOccupiedHullGapRatio
    }
  }
}

function intrinsicPressureContractionStep(index: number):
  | {
      readonly ratioScheduleIndex: 0 | 1 | 2
      readonly contractionRatio: number
    }
  | undefined {
  switch (index) {
    case 0:
      return { ratioScheduleIndex: 0, contractionRatio: INTRINSIC_PRESSURE_CONTRACTION_RATIOS[0] }
    case 1:
      return { ratioScheduleIndex: 1, contractionRatio: INTRINSIC_PRESSURE_CONTRACTION_RATIOS[1] }
    case 2:
      return { ratioScheduleIndex: 2, contractionRatio: INTRINSIC_PRESSURE_CONTRACTION_RATIOS[2] }
    default:
      return undefined
  }
}

export function pressureRepairSweepAllowance(
  totalSweepBudget: number,
  attemptIndex: number
): number {
  const boundedBudget = Math.max(0, Math.floor(totalSweepBudget))
  if (!Number.isInteger(attemptIndex) || attemptIndex < 0 || attemptIndex >= 3) return 0
  const quotient = Math.floor(boundedBudget / 3)
  const remainder = boundedBudget % 3
  return quotient + (attemptIndex < remainder ? 1 : 0)
}

export function pressureRepairMaximumSweepAllowance(
  totalSweepBudget: number,
  attemptIndex: number
): number {
  const mandatoryAdaptiveSweepCount = 4
  const maximumAdaptiveSweepCount = 8
  const mandatorySweepCount = pressureRepairSweepAllowance(
    totalSweepBudget,
    attemptIndex
  )
  return totalSweepBudget === 12 &&
    mandatorySweepCount === mandatoryAdaptiveSweepCount
    ? maximumAdaptiveSweepCount
    : mandatorySweepCount
}

export function advanceIntrinsicPressureAdaptiveDepth(input: {
  readonly completedSweepCount: number
  readonly mandatorySweepCount: number
  readonly priorBestRawLoss: number
  readonly completedBestRawLoss: number
  readonly consecutiveExtraNonImprovementCount: number
}): IntrinsicPressureAdaptiveDepthDecision {
  if (input.completedSweepCount <= input.mandatorySweepCount) {
    return { consecutiveExtraNonImprovementCount: 0, shouldStop: false }
  }
  const strictlyImproved = input.completedBestRawLoss < input.priorBestRawLoss
  const consecutiveExtraNonImprovementCount = strictlyImproved
    ? 0
    : input.consecutiveExtraNonImprovementCount + 1
  return {
    consecutiveExtraNonImprovementCount,
    shouldStop: consecutiveExtraNonImprovementCount >= 2
  }
}

export function isIntrinsicPressureActiveAtCap(input: {
  readonly adaptiveEnabled: boolean
  readonly completedSweepCount: number
  readonly maximumSweepCount: number
  readonly priorBestRawLoss: number
  readonly completedBestRawLoss: number
}): boolean {
  return (
    input.adaptiveEnabled &&
    input.completedSweepCount >= input.maximumSweepCount &&
    input.completedBestRawLoss > 0 &&
    input.completedBestRawLoss < input.priorBestRawLoss
  )
}

export function createIntrinsicPressureCanonicalLegalityMemo(): IntrinsicPressureCanonicalLegalityMemo {
  return {
    byStateKey: new Map(),
    requestCount: 0,
    evaluationCount: 0,
    cacheHitCount: 0,
    disagreementCount: 0
  }
}

/** Cross-classifies floating SAT diagnostics against authoritative grid legality. */
export function classifyIntrinsicPressureCanonicalLegality(input: {
  readonly targetBox: IntrinsicTargetBox
  readonly catalog: IntrinsicTransformCatalog
  readonly state: IntrinsicRelaxedState
  readonly evaluation: IntrinsicSeparationEvaluation
  readonly memo?: IntrinsicPressureCanonicalLegalityMemo
}): IntrinsicPressureCanonicalLegality {
  const memo = input.memo
  if (memo !== undefined) memo.requestCount += 1
  const stateKey = intrinsicRelaxedStateKey(input.catalog, input.state)
  const cached = stateKey === undefined ? undefined : memo?.byStateKey.get(stateKey)
  if (cached !== undefined) {
    if (memo !== undefined) memo.cacheHitCount += 1
    return cached
  }
  const placed = provisionalLayoutFromRelaxedState(input.catalog, input.state)
  const canonicalLegal =
    placed !== undefined && assertIntrinsicTargetExactLegal(input.targetBox, placed)
  const satExactZeroLoss = input.evaluation.exactZeroLoss
  const classification: IntrinsicPressureCanonicalClassification =
    placed === undefined || stateKey === undefined
      ? 'unmaterializable'
      : satExactZeroLoss
        ? canonicalLegal
          ? 'sat-clear-canonical-legal'
          : 'sat-clear-canonical-illegal'
        : canonicalLegal
          ? 'sat-conflict-canonical-legal'
          : 'sat-conflict-canonical-illegal'
  const result = {
    stateKey,
    satConflictCount: input.evaluation.conflicts.length,
    satExactZeroLoss,
    canonicalLegal,
    classification
  }
  if (memo !== undefined) {
    memo.evaluationCount += 1
    if (satExactZeroLoss !== canonicalLegal) memo.disagreementCount += 1
    if (stateKey !== undefined) memo.byStateKey.set(stateKey, result)
  }
  return result
}

function canonicalLegalityCounters(
  memo: IntrinsicPressureCanonicalLegalityMemo
): Omit<IntrinsicPressureCanonicalLegalityMemo, 'byStateKey'> {
  return {
    requestCount: memo.requestCount,
    evaluationCount: memo.evaluationCount,
    cacheHitCount: memo.cacheHitCount,
    disagreementCount: memo.disagreementCount
  }
}

function canonicalLegalityCounterDelta(
  before: Omit<IntrinsicPressureCanonicalLegalityMemo, 'byStateKey'>,
  after: IntrinsicPressureCanonicalLegalityMemo
): Pick<
  IntrinsicPressureCompositeParentTrace,
  | 'canonicalLegalityRequestCount'
  | 'canonicalLegalityEvaluationCount'
  | 'canonicalLegalityCacheHitCount'
  | 'canonicalLegalityDisagreementCount'
> {
  return {
    canonicalLegalityRequestCount: after.requestCount - before.requestCount,
    canonicalLegalityEvaluationCount: after.evaluationCount - before.evaluationCount,
    canonicalLegalityCacheHitCount: after.cacheHitCount - before.cacheHitCount,
    canonicalLegalityDisagreementCount:
      after.disagreementCount - before.disagreementCount
  }
}

/** General identity control independent of any fixed squeeze-role schedule. */
export function evaluateIntrinsicCanonicalControl(input: {
  readonly targetBox: IntrinsicTargetBox
  readonly referencePlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly candidatePlaced: ReadonlyArray<IrregularPlacedPiece>
}): IntrinsicCanonicalControlResult {
  const referenceCanonicalIdentity = canonicalCollisionLayoutIdentity(
    input.referencePlaced
  )
  const candidateCanonicalIdentity = canonicalCollisionLayoutIdentity(
    input.candidatePlaced
  )
  const referenceIds = input.referencePlaced.map(placedPieceId).toSorted()
  const candidateIds = input.candidatePlaced.map(placedPieceId).toSorted()
  const pieceCoverageMatches = sameSortedPieceIds(referenceIds, candidateIds)
  const identityMatches =
    referenceCanonicalIdentity !== undefined &&
    candidateCanonicalIdentity !== undefined &&
    referenceCanonicalIdentity === candidateCanonicalIdentity
  const candidateCanonicalLegal = assertIntrinsicTargetExactLegal(
    input.targetBox,
    input.candidatePlaced
  )
  const reason: IntrinsicCanonicalControlResult['reason'] =
    referenceCanonicalIdentity === undefined
      ? 'reference-identity-unavailable'
      : candidateCanonicalIdentity === undefined
        ? 'candidate-identity-unavailable'
        : !identityMatches
          ? 'identity-mismatch'
          : !pieceCoverageMatches
            ? 'piece-coverage-mismatch'
            : !candidateCanonicalLegal
              ? 'candidate-canonical-illegal'
              : 'accepted'
  return {
    referenceCanonicalIdentity,
    candidateCanonicalIdentity,
    identityMatches,
    pieceCoverageMatches,
    candidateCanonicalLegal,
    accepted: reason === 'accepted',
    reason
  }
}

function observeStructuralE1CanonicalControl(input: {
  readonly targetBox: IntrinsicTargetBox
  readonly catalog: IntrinsicTransformCatalog
  readonly state: IntrinsicRelaxedState
  readonly referencePlaced: ReadonlyArray<IrregularPlacedPiece>
}): IntrinsicStructuralE1CanonicalControlTrace | undefined {
  const stateKey = intrinsicRelaxedStateKey(input.catalog, input.state)
  const candidatePlaced = provisionalLayoutFromRelaxedState(input.catalog, input.state)
  const evaluation = evaluateIntrinsicSeparation(
    input.targetBox,
    input.catalog,
    input.state
  )
  if (stateKey === undefined || candidatePlaced === undefined || evaluation === undefined) {
    return undefined
  }
  const canonicalControl = evaluateIntrinsicCanonicalControl({
    targetBox: input.targetBox,
    referencePlaced: input.referencePlaced,
    candidatePlaced
  })
  const canonicalLegality = classifyIntrinsicPressureCanonicalLegality({
    targetBox: input.targetBox,
    catalog: input.catalog,
    state: input.state,
    evaluation
  })
  return {
    targetBox: input.targetBox,
    structuralPieceCount: input.referencePlaced.length,
    stateKey,
    satRawLoss: evaluation.rawLoss,
    satWeightedLoss: evaluation.weightedLoss,
    satConflictCount: evaluation.conflicts.length,
    satExactZeroLoss: evaluation.exactZeroLoss,
    satConflict: pressureConflictTuple(evaluation),
    canonicalControl,
    canonicalLegality,
    canonicalAcceptanceIndependentOfSat: canonicalControl.accepted,
    separationEvaluationBudgetCost: 0,
    selectionEligible: false
  }
}

/** Bounded family representatives selected only for axes implicated by current conflicts. */
export function generateIntrinsicAdaptiveTransformFamilyCandidates(input: {
  readonly catalog: IntrinsicTransformCatalog
  readonly state: IntrinsicRelaxedState
  readonly evaluation: IntrinsicSeparationEvaluation
  readonly selectedPieceId: PieceId
}): IntrinsicAdaptiveTransformFamilyCandidateSet {
  const pose = input.state.poses.find(
    ({ pieceId }) => pieceId === input.selectedPieceId
  )
  const catalogEntry = input.catalog.entries.find(
    ({ pieceId }) => pieceId === input.selectedPieceId
  )
  const currentTransform = catalogEntry?.transforms.find(
    ({ canonicalTransformKey }) => canonicalTransformKey === pose?.transformKey
  )
  if (pose === undefined || catalogEntry === undefined || currentTransform === undefined) {
    return {
      selectedAxes: [],
      generatedCount: 0,
      materializedCount: 0,
      uniqueCount: 0,
      candidates: []
    }
  }
  const selectedAxes = pressureSelectedConflictAxes(
    input.evaluation,
    input.selectedPieceId
  )
  const currentBounds = intrinsicFiniteTransformGridBounds(currentTransform)
  if (currentBounds === undefined || selectedAxes.length === 0) {
    return {
      selectedAxes,
      generatedCount: 0,
      materializedCount: 0,
      uniqueCount: 0,
      candidates: []
    }
  }
  const currentCenterX =
    pose.translateXGrid + (currentBounds.minimumX + currentBounds.maximumX) / 2
  const currentCenterY =
    pose.translateYGrid + (currentBounds.minimumY + currentBounds.maximumY) / 2
  const unique = new Map<string, IntrinsicAdaptiveTransformFamilyCandidate>()
  let generatedCount = 0
  let materializedCount = 0
  for (const axis of selectedAxes) {
    const byFamily = new Map<
      string,
      (typeof catalogEntry.transforms)[number]
    >()
    for (const finiteTransform of catalogEntry.transforms) {
      const existing = byFamily.get(finiteTransform.orientationFamily)
      if (
        existing === undefined ||
        compareFiniteTransformForPressureAxis(finiteTransform, existing, axis) < 0
      ) {
        byFamily.set(finiteTransform.orientationFamily, finiteTransform)
      }
    }
    const representatives = [...byFamily.values()].toSorted((first, second) =>
      first.orientationFamily.localeCompare(second.orientationFamily)
    )
    for (const [ordinal, finiteTransform] of representatives.entries()) {
      generatedCount += 1
      const bounds = intrinsicFiniteTransformGridBounds(finiteTransform)
      if (bounds === undefined) continue
      const translateXGrid = Math.round(
        currentCenterX - (bounds.minimumX + bounds.maximumX) / 2
      )
      const translateYGrid = Math.round(
        currentCenterY - (bounds.minimumY + bounds.maximumY) / 2
      )
      const state = canonicalizeRelaxedState(input.catalog, {
        poses: input.state.poses.map((candidatePose) =>
          candidatePose.pieceId === input.selectedPieceId
            ? {
                ...candidatePose,
                transformKey: finiteTransform.canonicalTransformKey,
                translateXGrid,
                translateYGrid
              }
            : candidatePose
        )
      })
      const stateKey =
        state === undefined
          ? undefined
          : intrinsicRelaxedStateKey(input.catalog, state)
      const selectedPose = state?.poses.find(
        ({ pieceId }) => pieceId === input.selectedPieceId
      )
      if (state === undefined || stateKey === undefined || selectedPose === undefined) {
        continue
      }
      materializedCount += 1
      if (unique.has(stateKey)) continue
      unique.set(stateKey, {
        state,
        stateKey,
        source: 'adaptive-transform-family',
        pass: axis === 'x' ? 'adaptive-axis-x' : 'adaptive-axis-y',
        ordinal,
        orientationFamily: finiteTransform.orientationFamily,
        transformKey: selectedPose.transformKey,
        translateXGrid: selectedPose.translateXGrid,
        translateYGrid: selectedPose.translateYGrid
      })
    }
  }
  return {
    selectedAxes,
    generatedCount,
    materializedCount,
    uniqueCount: unique.size,
    candidates: [...unique.values()]
  }
}

/** Dormant two-radius intensifier for a future explicitly selected V7 atom or endpoint. */
export function generateIntrinsicTwoRadiusRefinementCandidates(input: {
  readonly targetBox: IntrinsicTargetBox
  readonly catalog: IntrinsicTransformCatalog
  readonly seedState: IntrinsicRelaxedState
  readonly selectedPieceId: PieceId
}): IntrinsicTwoRadiusRefinementCandidateSet | undefined {
  const pose = input.seedState.poses.find(
    ({ pieceId }) => pieceId === input.selectedPieceId
  )
  const finiteTransform = input.catalog.entries
    .find(({ pieceId }) => pieceId === input.selectedPieceId)
    ?.transforms.find(
      ({ canonicalTransformKey }) => canonicalTransformKey === pose?.transformKey
    )
  const bounds =
    finiteTransform === undefined
      ? undefined
      : intrinsicFiniteTransformGridBounds(finiteTransform)
  const targetWidthGrid = toGridMm(input.targetBox.widthMm)
  const targetHeightGrid = toGridMm(input.targetBox.heightMm)
  if (
    pose === undefined ||
    finiteTransform === undefined ||
    bounds === undefined ||
    targetWidthGrid === undefined ||
    targetHeightGrid === undefined
  ) {
    return undefined
  }
  const minimumTranslateXGrid = -bounds.minimumX
  const maximumTranslateXGrid = targetWidthGrid - bounds.maximumX
  const minimumTranslateYGrid = -bounds.minimumY
  const maximumTranslateYGrid = targetHeightGrid - bounds.maximumY
  const widthGrid = bounds.maximumX - bounds.minimumX
  const heightGrid = bounds.maximumY - bounds.minimumY
  const characteristicGrid = Math.max(
    1,
    Math.min(widthGrid, heightGrid) || Math.max(widthGrid, heightGrid)
  )
  const smallRadiusGrid = Math.max(1, Math.round(characteristicGrid / 32))
  const largeRadiusGrid = Math.max(
    smallRadiusGrid + 1,
    Math.round(characteristicGrid / 8)
  )
  const directions = [
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: 0 },
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 }
  ] as const
  const unique = new Map<string, IntrinsicTwoRadiusRefinementCandidate>()
  let targetLegalCount = 0
  for (const [radiusIndex, radiusGrid] of [
    smallRadiusGrid,
    largeRadiusGrid
  ].entries()) {
    for (const [directionIndex, direction] of directions.entries()) {
      const translateXGrid = pose.translateXGrid + direction.x * radiusGrid
      const translateYGrid = pose.translateYGrid + direction.y * radiusGrid
      if (
        translateXGrid < minimumTranslateXGrid ||
        translateXGrid > maximumTranslateXGrid ||
        translateYGrid < minimumTranslateYGrid ||
        translateYGrid > maximumTranslateYGrid
      ) {
        continue
      }
      targetLegalCount += 1
      const state = transportIntrinsicGroup(
        input.catalog,
        input.seedState,
        [input.selectedPieceId],
        {
          x: translateXGrid - pose.translateXGrid,
          y: translateYGrid - pose.translateYGrid
        }
      )
      const stateKey =
        state === undefined
          ? undefined
          : intrinsicRelaxedStateKey(input.catalog, state)
      const selectedPose = state?.poses.find(
        ({ pieceId }) => pieceId === input.selectedPieceId
      )
      if (state === undefined || stateKey === undefined || selectedPose === undefined) {
        continue
      }
      if (unique.has(stateKey)) continue
      unique.set(stateKey, {
        state,
        stateKey,
        source: radiusIndex === 0 ? 'refine-small' : 'refine-large',
        ordinal: radiusIndex * directions.length + directionIndex,
        transformKey: selectedPose.transformKey,
        translateXGrid: selectedPose.translateXGrid,
        translateYGrid: selectedPose.translateYGrid
      })
    }
  }
  return {
    invoked: true,
    generatedCount: 16,
    targetLegalCount,
    uniqueCount: unique.size,
    smallRadiusGrid,
    largeRadiusGrid,
    candidates: [...unique.values()]
  }
}

interface IntrinsicFiniteTransformGridBounds {
  readonly minimumX: number
  readonly minimumY: number
  readonly maximumX: number
  readonly maximumY: number
}

function intrinsicFiniteTransformGridBounds(
  finiteTransform: IntrinsicTransformCatalog['entries'][number]['transforms'][number]
): IntrinsicFiniteTransformGridBounds | undefined {
  const points = finiteTransform.geometry.polygon.points.map(({ x, y }) => ({
    x: toGridMm(x),
    y: toGridMm(y)
  }))
  if (
    points.length < 3 ||
    points.some(({ x, y }) => x === undefined || y === undefined)
  ) {
    return undefined
  }
  const complete = points.filter(
    (point): point is { readonly x: number; readonly y: number } =>
      point.x !== undefined && point.y !== undefined
  )
  return {
    minimumX: Math.min(...complete.map(({ x }) => x)),
    minimumY: Math.min(...complete.map(({ y }) => y)),
    maximumX: Math.max(...complete.map(({ x }) => x)),
    maximumY: Math.max(...complete.map(({ y }) => y))
  }
}

function compareFiniteTransformForPressureAxis(
  first: IntrinsicTransformCatalog['entries'][number]['transforms'][number],
  second: IntrinsicTransformCatalog['entries'][number]['transforms'][number],
  axis: IntrinsicPressureAxis
): number {
  const firstBounds = intrinsicFiniteTransformGridBounds(first)
  const secondBounds = intrinsicFiniteTransformGridBounds(second)
  if (firstBounds === undefined) return secondBounds === undefined ? 0 : 1
  if (secondBounds === undefined) return -1
  const firstSpan =
    axis === 'x'
      ? firstBounds.maximumX - firstBounds.minimumX
      : firstBounds.maximumY - firstBounds.minimumY
  const secondSpan =
    axis === 'x'
      ? secondBounds.maximumX - secondBounds.minimumX
      : secondBounds.maximumY - secondBounds.minimumY
  return (
    firstSpan - secondSpan ||
    first.canonicalTransformKey.localeCompare(second.canonicalTransformKey)
  )
}

function pressureSelectedConflictAxes(
  evaluation: IntrinsicSeparationEvaluation,
  pieceId: PieceId
): ReadonlyArray<IntrinsicPressureAxis> {
  let xContribution = 0
  let yContribution = 0
  for (const conflict of evaluation.conflicts) {
    if (
      conflict.firstPieceId !== pieceId &&
      conflict.secondPieceId !== pieceId
    ) {
      continue
    }
    xContribution += Math.abs(conflict.moveXGrid) * conflict.normalizedDepth
    yContribution += Math.abs(conflict.moveYGrid) * conflict.normalizedDepth
  }
  if (xContribution === 0 && yContribution === 0) return []
  if (xContribution === yContribution) return ['x', 'y']
  return xContribution > yContribution ? ['x'] : ['y']
}

export function runIntrinsicSequentialColliderComposite(input: {
  readonly targetBox: IntrinsicTargetBox
  readonly catalog: IntrinsicTransformCatalog
  readonly parentState: IntrinsicRelaxedState
  readonly parentEvaluation: IntrinsicSeparationEvaluation
  readonly parentStateKey: string
  readonly weights: IntrinsicSeparatorWeights
  readonly maximumEvaluations: number
  readonly control: IrregularNfpIfpControl
  readonly canonicalLegalityMemo?: IntrinsicPressureCanonicalLegalityMemo
  readonly orderIdentity?: IntrinsicPressureCompositeOrderIdentity
}): Effect.Effect<
  IntrinsicSequentialColliderCompositeResult,
  IrregularNfpIfpControlAbortError
> {
  return Effect.gen(function* () {
    const orderIdentity = input.orderIdentity ?? 'priority-forward'
    const canonicalLegalityMemo =
      input.canonicalLegalityMemo ?? createIntrinsicPressureCanonicalLegalityMemo()
    const initialCanonicalCounters = canonicalLegalityCounters(canonicalLegalityMemo)
    const colliderIds = pressureConflictedPieceIds(input.parentEvaluation)
    const priorityColliderIds =
      intrinsicProjectionPriority(
        input.catalog,
        input.parentState,
        input.parentEvaluation,
        input.weights
      )?.filter((pieceId) => colliderIds.has(pieceId)) ?? []
    const frozenColliderIds =
      orderIdentity === 'priority-reverse'
        ? priorityColliderIds.toReversed()
        : priorityColliderIds
    const visitedPieceIds: PieceId[] = []
    const alreadyClearPieceIds: PieceId[] = []
    const committedPieceIds: PieceId[] = []
    const skippedPieceIds: PieceId[] = []
    const distinctAffectedPieceIds = new Set<PieceId>()
    const visits: IntrinsicPressureCompositeVisitTrace[] = []
    let currentState = input.parentState
    let currentEvaluation = input.parentEvaluation
    let currentStateKey = input.parentStateKey
    let evaluationCount = 0
    let exactZeroIntermediateVisitIndex: number | undefined
    let canonicalLegalIntermediateVisitIndex: number | undefined
    let evaluationCapReached = false
    let deadlineReached = false

    const finish = (): IntrinsicSequentialColliderCompositeResult => {
      const interrupted = evaluationCapReached || deadlineReached
      const emittedComposite =
        !interrupted &&
        distinctAffectedPieceIds.size > 0 &&
        currentStateKey !== input.parentStateKey
      return {
        state: currentState,
        evaluation: currentEvaluation,
        key: currentStateKey,
        affectedPieceIds: [...distinctAffectedPieceIds].toSorted((first, second) =>
          first.localeCompare(second)
        ),
        evaluationCount,
        exactZeroIntermediate: exactZeroIntermediateVisitIndex !== undefined,
        canonicalLegalIntermediate:
          canonicalLegalIntermediateVisitIndex !== undefined,
        evaluationCapReached,
        deadlineReached,
        trace: {
          parentStateKey: input.parentStateKey,
          compositeStateKey: currentStateKey,
          frozenColliderIds,
          visitedPieceIds,
          alreadyClearPieceIds,
          committedPieceIds,
          skippedPieceIds,
          frozenColliderCount: frozenColliderIds.length,
          visitedPieceCount: visitedPieceIds.length,
          alreadyClearPieceCount: alreadyClearPieceIds.length,
          committedPieceCount: committedPieceIds.length,
          skippedPieceCount: skippedPieceIds.length,
          distinctAffectedPieceCount: distinctAffectedPieceIds.size,
          visits,
          startRawLoss: input.parentEvaluation.rawLoss,
          startWeightedLoss: intrinsicWeightedLoss(
            input.parentEvaluation,
            input.weights
          ),
          endRawLoss: currentEvaluation.rawLoss,
          endWeightedLoss: intrinsicWeightedLoss(currentEvaluation, input.weights),
          startPairConflictCount: pressurePairConflictCount(
            input.parentEvaluation
          ),
          endPairConflictCount: pressurePairConflictCount(currentEvaluation),
          startConflictedPieceCount: pressureConflictedPieceIds(
            input.parentEvaluation
          ).size,
          endConflictedPieceCount: pressureConflictedPieceIds(currentEvaluation).size,
          exactZeroIntermediateVisitIndex,
          canonicalLegalIntermediateVisitIndex,
          ...canonicalLegalityCounterDelta(
            initialCanonicalCounters,
            canonicalLegalityMemo
          ),
          evaluationCount,
          evaluationCapReached,
          deadlineReached,
          emittedComposite,
          outerRetentionOutcome: interrupted ? 'interrupted' : 'not-emitted',
          orderIdentity,
          candidateAccounting: mergePressureCandidateAccounting(
            visits.flatMap(({ candidateAccounting }) => candidateAccounting)
          ),
          winnerSource:
            visits.findLast(
              ({ selectedCandidateSource }) =>
                selectedCandidateSource !== 'no-op'
            )?.selectedCandidateSource ?? 'no-op',
          winnerStateKey: currentStateKey,
          winnerSurvivedComposite: emittedComposite
        }
      }
    }

    for (const [visitIndex, pieceId] of frozenColliderIds.entries()) {
      if ((yield* globalSearchCheckpoint(input.control)) === 'deadline') {
        deadlineReached = true
        return finish()
      }
      visitedPieceIds.push(pieceId)
      const beforeEvaluation = currentEvaluation
      const beforeWeightedLoss = intrinsicWeightedLoss(
        beforeEvaluation,
        input.weights
      )
      if (!pressurePieceHasConflict(beforeEvaluation, pieceId)) {
        alreadyClearPieceIds.push(pieceId)
        visits.push(
          pressureCompositeVisitTrace({
            pieceId,
            outcome: 'already-clear',
            proposalCount: 1,
            evaluationCount: 0,
            selectedStateKey: currentStateKey,
            before: beforeEvaluation,
            after: beforeEvaluation,
            weights: input.weights,
            canonicalLegality: undefined
          })
        )
        continue
      }
      const existingProposals = intrinsicFocusedProposalsForPiece({
        catalog: input.catalog,
        state: currentState,
        evaluation: currentEvaluation,
        weights: input.weights,
        selectedPieceId: pieceId
      })
      const adaptiveFamilySet = generateIntrinsicAdaptiveTransformFamilyCandidates({
        catalog: input.catalog,
        state: currentState,
        evaluation: currentEvaluation,
        selectedPieceId: pieceId
      })
      const rawCandidates: Array<{
        readonly state: IntrinsicRelaxedState
        readonly source: IntrinsicPressureCompositeCandidateSource
        readonly pass: IntrinsicPressureCandidatePass
        readonly ordinal: number
        readonly knownStateKey?: string
        readonly orientationFamily?: string
      }> = [
        ...existingProposals.map((proposal, ordinal) => ({
          state: proposal.state,
          source: (proposal.kind === 'transform'
            ? 'existing-transform'
            : 'existing-separate') as IntrinsicPressureCompositeCandidateSource,
          pass: 'existing' as const,
          ordinal
        })),
        ...adaptiveFamilySet.candidates.map((candidate) => ({
          state: candidate.state,
          source: candidate.source as IntrinsicPressureCompositeCandidateSource,
          pass: candidate.pass as IntrinsicPressureCandidatePass,
          ordinal: candidate.ordinal,
          knownStateKey: candidate.stateKey,
          orientationFamily: candidate.orientationFamily
        }))
      ]
      const seenStateKeys = new Set([currentStateKey])
      const candidateTraces: IntrinsicPressureCandidateTrace[] = []
      const proposals = rawCandidates.flatMap((candidate) => {
        const stateKey =
          candidate.knownStateKey ??
          intrinsicRelaxedStateKey(input.catalog, candidate.state)
        const pose = pressurePoseTrace(candidate.state, pieceId)
        if (stateKey === undefined) {
          candidateTraces.push(
            pressureCandidateTrace(candidate, pose, undefined, 'invalid')
          )
          return []
        }
        if (seenStateKeys.has(stateKey)) {
          candidateTraces.push(
            pressureCandidateTrace(candidate, pose, stateKey, 'deduplicated')
          )
          return []
        }
        seenStateKeys.add(stateKey)
        candidateTraces.push(
          pressureCandidateTrace(candidate, pose, stateKey, 'cap-skipped')
        )
        return [{ ...candidate, stateKey, pose, traceIndex: candidateTraces.length - 1 }]
      })
      const choices: Array<{
        readonly state: IntrinsicRelaxedState
        readonly evaluation: IntrinsicSeparationEvaluation
        readonly stateKey: string
        readonly source: IntrinsicPressureCompositeCandidateSource
        readonly pass: IntrinsicPressureCandidatePass
        readonly ordinal: number
        readonly orientationFamily: string | undefined
        readonly pose: IntrinsicRelaxedPose | undefined
        readonly traceIndex: number
      }> = []
      let visitEvaluationCount = 0
      for (const candidate of proposals) {
        if (evaluationCount >= input.maximumEvaluations) {
          evaluationCapReached = true
          break
        }
        if ((yield* globalSearchCheckpoint(input.control)) === 'deadline') {
          deadlineReached = true
          break
        }
        const evaluation = evaluateIntrinsicSeparation(
          input.targetBox,
          input.catalog,
          candidate.state,
          input.weights
        )
        evaluationCount += 1
        visitEvaluationCount += 1
        if (evaluation === undefined) {
          candidateTraces[candidate.traceIndex] = pressureCandidateTrace(
            candidate,
            candidate.pose,
            candidate.stateKey,
            'invalid'
          )
          continue
        }
        const conflict = pressureConflictTuple(evaluation)
        candidateTraces[candidate.traceIndex] = {
          ...pressureCandidateTrace(
            candidate,
            candidate.pose,
            candidate.stateKey,
            'evaluated'
          ),
          conflict,
          incidentClear: pressurePieceConflictCount(evaluation, pieceId) === 0,
          globallyClear: conflict.wallConflictCount + conflict.pairConflictCount === 0,
          rawLoss: evaluation.rawLoss,
          weightedLoss: intrinsicWeightedLoss(evaluation, input.weights)
        }
        choices.push({
          state: candidate.state,
          evaluation,
          stateKey: candidate.stateKey,
          source: candidate.source,
          pass: candidate.pass,
          ordinal: candidate.ordinal,
          orientationFamily: candidate.orientationFamily,
          pose: candidate.pose,
          traceIndex: candidate.traceIndex
        })
      }
      if (evaluationCapReached || deadlineReached) {
        visits.push(
          pressureCompositeVisitTrace({
            pieceId,
            outcome: evaluationCapReached ? 'evaluation-cap' : 'deadline',
            proposalCount: rawCandidates.length + 1,
            evaluationCount: visitEvaluationCount,
            selectedStateKey: currentStateKey,
            before: beforeEvaluation,
            after: beforeEvaluation,
            weights: input.weights,
            canonicalLegality: undefined,
            candidates: candidateTraces
          })
        )
        return finish()
      }
      const selectedStateKey = selectIntrinsicPressureCompositeChoice(
        beforeWeightedLoss,
        choices.map(({ evaluation, stateKey }) => ({
          stateKey,
          weightedLoss: intrinsicWeightedLoss(evaluation, input.weights),
          rawLoss: evaluation.rawLoss
        }))
      )
      const selected = choices.find(({ stateKey }) => stateKey === selectedStateKey)
      if (selected === undefined) {
        skippedPieceIds.push(pieceId)
        visits.push(
          pressureCompositeVisitTrace({
            pieceId,
            outcome: 'no-op',
            proposalCount: rawCandidates.length + 1,
            evaluationCount: visitEvaluationCount,
            selectedStateKey: currentStateKey,
            before: beforeEvaluation,
            after: beforeEvaluation,
            weights: input.weights,
            canonicalLegality: undefined,
            candidates: candidateTraces
          })
        )
        continue
      }
      if (evaluationCount >= input.maximumEvaluations) {
        evaluationCapReached = true
        visits.push(
          pressureCompositeVisitTrace({
            pieceId,
            outcome: 'evaluation-cap',
            proposalCount: rawCandidates.length + 1,
            evaluationCount: visitEvaluationCount,
            selectedStateKey: currentStateKey,
            before: beforeEvaluation,
            after: beforeEvaluation,
            weights: input.weights,
            canonicalLegality: undefined,
            candidates: candidateTraces
          })
        )
        return finish()
      }
      if ((yield* globalSearchCheckpoint(input.control)) === 'deadline') {
        deadlineReached = true
        visits.push(
          pressureCompositeVisitTrace({
            pieceId,
            outcome: 'deadline',
            proposalCount: rawCandidates.length + 1,
            evaluationCount: visitEvaluationCount,
            selectedStateKey: currentStateKey,
            before: beforeEvaluation,
            after: beforeEvaluation,
            weights: input.weights,
            canonicalLegality: undefined,
            candidates: candidateTraces
          })
        )
        return finish()
      }
      const recomputedEvaluation = evaluateIntrinsicSeparation(
        input.targetBox,
        input.catalog,
        selected.state,
        input.weights
      )
      evaluationCount += 1
      visitEvaluationCount += 1
      if (recomputedEvaluation === undefined) {
        skippedPieceIds.push(pieceId)
        visits.push(
          pressureCompositeVisitTrace({
            pieceId,
            outcome: 'no-op',
            proposalCount: rawCandidates.length + 1,
            evaluationCount: visitEvaluationCount,
            selectedStateKey: currentStateKey,
            before: beforeEvaluation,
            after: beforeEvaluation,
            weights: input.weights,
            canonicalLegality: undefined,
            candidates: candidateTraces
          })
        )
        continue
      }
      currentState = selected.state
      currentEvaluation = recomputedEvaluation
      currentStateKey = selected.stateKey
      committedPieceIds.push(pieceId)
      distinctAffectedPieceIds.add(pieceId)
      const exactZero = recomputedEvaluation.exactZeroLoss
      const selectedCandidateTrace = candidateTraces[selected.traceIndex]
      if (selectedCandidateTrace !== undefined) {
        candidateTraces[selected.traceIndex] = {
          ...selectedCandidateTrace,
          outcome: 'selected'
        }
      }
      if (exactZero) exactZeroIntermediateVisitIndex = visitIndex
      const canonicalLegality = classifyIntrinsicPressureCanonicalLegality({
        targetBox: input.targetBox,
        catalog: input.catalog,
        state: selected.state,
        evaluation: recomputedEvaluation,
        memo: canonicalLegalityMemo
      })
      if (canonicalLegality.canonicalLegal) {
        canonicalLegalIntermediateVisitIndex = visitIndex
      }
      visits.push(
        pressureCompositeVisitTrace({
          pieceId,
          outcome: canonicalLegality.canonicalLegal
            ? 'canonical-legal'
            : 'committed',
          proposalCount: rawCandidates.length + 1,
          evaluationCount: visitEvaluationCount,
          selectedStateKey: currentStateKey,
          before: beforeEvaluation,
          after: recomputedEvaluation,
          weights: input.weights,
          canonicalLegality,
          candidates: candidateTraces,
          selected
        })
      )
      if (canonicalLegality.canonicalLegal) return finish()
    }
    return finish()
  })
}

export function selectIntrinsicPressureCompositeChoice(
  currentWeightedLoss: number,
  choices: ReadonlyArray<IntrinsicPressureCompositeChoiceScore>
): string | undefined {
  const selected = choices.toSorted(
    (first, second) =>
      first.weightedLoss - second.weightedLoss ||
      first.rawLoss - second.rawLoss ||
      first.stateKey.localeCompare(second.stateKey)
  )[0]
  return selected !== undefined &&
    selected.weightedLoss <= currentWeightedLoss * 1.001
    ? selected.stateKey
    : undefined
}

function pressureCompositeVisitTrace(input: {
  readonly pieceId: PieceId
  readonly outcome: IntrinsicPressureCompositeVisitTrace['outcome']
  readonly proposalCount: number
  readonly evaluationCount: number
  readonly selectedStateKey: string | undefined
  readonly before: IntrinsicSeparationEvaluation
  readonly after: IntrinsicSeparationEvaluation
  readonly weights: IntrinsicSeparatorWeights
  readonly canonicalLegality: IntrinsicPressureCanonicalLegality | undefined
  readonly candidates?: ReadonlyArray<IntrinsicPressureCandidateTrace>
  readonly selected?: {
    readonly source: IntrinsicPressureCompositeCandidateSource
    readonly ordinal: number
    readonly orientationFamily: string | undefined
    readonly pose: IntrinsicRelaxedPose | undefined
  }
}): IntrinsicPressureCompositeVisitTrace {
  const candidates = input.candidates ?? []
  return {
    pieceId: input.pieceId,
    outcome: input.outcome,
    proposalCount: input.proposalCount,
    evaluationCount: input.evaluationCount,
    selectedStateKey: input.selectedStateKey,
    beforeRawLoss: input.before.rawLoss,
    beforeWeightedLoss: intrinsicWeightedLoss(input.before, input.weights),
    afterRawLoss: input.after.rawLoss,
    afterWeightedLoss: intrinsicWeightedLoss(input.after, input.weights),
    beforePairConflictCount: pressurePairConflictCount(input.before),
    afterPairConflictCount: pressurePairConflictCount(input.after),
    beforeConflictedPieceCount: pressureConflictedPieceIds(input.before).size,
    afterConflictedPieceCount: pressureConflictedPieceIds(input.after).size,
    canonicalLegality: input.canonicalLegality,
    conflictBefore: pressureConflictTuple(input.before),
    conflictAfter: pressureConflictTuple(input.after),
    candidateAccounting: pressureCandidateAccounting(candidates),
    candidates,
    selectedCandidateSource: input.selected?.source ?? 'no-op',
    selectedCandidateOrdinal: input.selected?.ordinal,
    selectedOrientationFamily: input.selected?.orientationFamily,
    selectedTransformKey: input.selected?.pose?.transformKey,
    selectedTranslateXGrid: input.selected?.pose?.translateXGrid,
    selectedTranslateYGrid: input.selected?.pose?.translateYGrid
  }
}

function pressureCandidateTrace(
  candidate: {
    readonly source: IntrinsicPressureCompositeCandidateSource
    readonly pass: IntrinsicPressureCandidatePass
    readonly ordinal: number
    readonly orientationFamily?: string
  },
  pose: IntrinsicRelaxedPose | undefined,
  stateKey: string | undefined,
  outcome: IntrinsicPressureCandidateTrace['outcome']
): IntrinsicPressureCandidateTrace {
  return {
    source: candidate.source,
    pass: candidate.pass,
    ordinal: candidate.ordinal,
    orientationFamily: candidate.orientationFamily,
    stateKey,
    transformKey: pose?.transformKey,
    translateXGrid: pose?.translateXGrid,
    translateYGrid: pose?.translateYGrid,
    conflict: undefined,
    incidentClear: undefined,
    globallyClear: undefined,
    rawLoss: undefined,
    weightedLoss: undefined,
    outcome
  }
}

function pressurePoseTrace(
  state: IntrinsicRelaxedState,
  pieceId: PieceId
): IntrinsicRelaxedPose | undefined {
  return state.poses.find(({ pieceId: candidatePieceId }) => candidatePieceId === pieceId)
}

function pressureConflictTuple(
  evaluation: IntrinsicSeparationEvaluation
): IntrinsicPressureConflictTuple {
  return {
    wallConflictCount: evaluation.conflicts.filter(({ kind }) => kind === 'wall')
      .length,
    pairConflictCount: pressurePairConflictCount(evaluation),
    conflictedPieceCount: pressureConflictedPieceIds(evaluation).size
  }
}

function pressurePieceConflictCount(
  evaluation: IntrinsicSeparationEvaluation,
  pieceId: PieceId
): number {
  return evaluation.conflicts.filter(
    ({ firstPieceId, secondPieceId }) =>
      firstPieceId === pieceId || secondPieceId === pieceId
  ).length
}

function pressureCandidateAccounting(
  candidates: ReadonlyArray<IntrinsicPressureCandidateTrace>
): ReadonlyArray<IntrinsicPressureCandidateAccounting> {
  const groups = new Map<
    string,
    {
      readonly source: IntrinsicPressureCompositeCandidateSource
      readonly pass: IntrinsicPressureCandidatePass
      readonly candidates: IntrinsicPressureCandidateTrace[]
    }
  >()
  for (const candidate of candidates) {
    const key = `${candidate.source}:${candidate.pass}`
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        source: candidate.source,
        pass: candidate.pass,
        candidates: [candidate]
      })
    } else {
      existing.candidates.push(candidate)
    }
  }
  return [...groups.values()]
    .map(({ source, pass, candidates: entries }) => ({
      source,
      pass,
      generatedCount: entries.length,
      materializedCount: entries.filter(({ stateKey }) => stateKey !== undefined)
        .length,
      legalCount: entries.filter(
        ({ conflict }) => conflict !== undefined && conflict.wallConflictCount === 0
      ).length,
      uniqueCount: entries.filter(
        ({ outcome }) => outcome !== 'deduplicated' && outcome !== 'invalid'
      ).length,
      evaluatedCount: entries.filter(
        ({ outcome }) => outcome === 'evaluated' || outcome === 'selected'
      ).length,
      incidentClearCount: entries.filter(({ incidentClear }) => incidentClear === true)
        .length,
      globallyClearCount: entries.filter(({ globallyClear }) => globallyClear === true)
        .length,
      selectedCount: entries.filter(({ outcome }) => outcome === 'selected').length,
      capSkippedCount: entries.filter(({ outcome }) => outcome === 'cap-skipped')
        .length
    }))
    .toSorted(
      (first, second) =>
        first.pass.localeCompare(second.pass) ||
        first.source.localeCompare(second.source)
    )
}

function mergePressureCandidateAccounting(
  accounting: ReadonlyArray<IntrinsicPressureCandidateAccounting>
): ReadonlyArray<IntrinsicPressureCandidateAccounting> {
  const grouped = new Map<string, IntrinsicPressureCandidateAccounting>()
  for (const entry of accounting) {
    const key = `${entry.source}:${entry.pass}`
    const existing = grouped.get(key)
    grouped.set(
      key,
      existing === undefined
        ? entry
        : {
            source: entry.source,
            pass: entry.pass,
            generatedCount: existing.generatedCount + entry.generatedCount,
            materializedCount: existing.materializedCount + entry.materializedCount,
            legalCount: existing.legalCount + entry.legalCount,
            uniqueCount: existing.uniqueCount + entry.uniqueCount,
            evaluatedCount: existing.evaluatedCount + entry.evaluatedCount,
            incidentClearCount:
              existing.incidentClearCount + entry.incidentClearCount,
            globallyClearCount:
              existing.globallyClearCount + entry.globallyClearCount,
            selectedCount: existing.selectedCount + entry.selectedCount,
            capSkippedCount: existing.capSkippedCount + entry.capSkippedCount
          }
    )
  }
  return [...grouped.values()].toSorted(
    (first, second) =>
      first.pass.localeCompare(second.pass) ||
      first.source.localeCompare(second.source)
  )
}

function pressurePairConflictCount(
  evaluation: IntrinsicSeparationEvaluation
): number {
  return evaluation.conflicts.filter(({ kind }) => kind === 'pair').length
}

function pressureConflictedPieceIds(
  evaluation: IntrinsicSeparationEvaluation
): ReadonlySet<PieceId> {
  const pieceIds = new Set<PieceId>()
  for (const conflict of evaluation.conflicts) {
    pieceIds.add(conflict.firstPieceId)
    if (conflict.secondPieceId !== undefined) pieceIds.add(conflict.secondPieceId)
  }
  return pieceIds
}

function pressurePieceHasConflict(
  evaluation: IntrinsicSeparationEvaluation,
  pieceId: PieceId
): boolean {
  return evaluation.conflicts.some(
    ({ firstPieceId, secondPieceId }) =>
      firstPieceId === pieceId || secondPieceId === pieceId
  )
}

function unavailableContractedPressureAttemptTrace(input: {
  readonly attemptIndex: number
  readonly ratioScheduleIndex: 0 | 1 | 2
  readonly contractionRatio: number
  readonly parent: IntrinsicPressureMeasuredLayout
  readonly retainedPressureIdentity: string | undefined
  readonly reason: string
}): IntrinsicContractedPressureAttemptTrace {
  const contraction = pressureContractionBox(
    input.parent.occupiedBox,
    input.contractionRatio
  )
  return {
    attemptIndex: input.attemptIndex,
    ratioScheduleIndex: input.ratioScheduleIndex,
    parentCompactness: input.parent.compactness,
    occupiedBox: input.parent.occupiedBox,
    contractedBox: contraction?.targetBox ?? {
      widthMm: input.parent.occupiedBox.widthMm,
      heightMm: input.parent.occupiedBox.heightMm
    },
    contractionAxis: contraction?.axis ?? 'x',
    contractionRatio: input.contractionRatio,
    removedWidthMm: contraction?.removedWidthMm ?? 0,
    areaWeightedMedianGrid: undefined,
    nearPartitionPieceIds: [],
    farPartitionPieceIds: [],
    translatedPartitionPieceIds: [],
    proposalIdentity: undefined,
    proposalRawLoss: undefined,
    proposalWeightedLoss: undefined,
    proposalDispersion: undefined,
    separationEvaluationCount: 0,
    bestRepairedLoss: undefined,
    bestEndpointExact: false,
    bestEndpointSatExactZero: false,
    bestEndpointCanonicalClassification: undefined,
    canonicalLegalityRequestCount: 0,
    canonicalLegalityEvaluationCount: 0,
    canonicalLegalityCacheHitCount: 0,
    canonicalLegalityDisagreementCount: 0,
    bestEndpointCompactness: undefined,
    outcome: 'rejected',
    reason: input.reason,
    retainedPressureIdentity: input.retainedPressureIdentity,
    preProjectionCompactness: undefined,
    postProjectionCompactness: undefined,
    repairSweeps: []
  }
}

function contractedPressureAttemptTrace(input: {
  readonly attemptIndex: number
  readonly ratioScheduleIndex: 0 | 1 | 2
  readonly proposal: IntrinsicContractedPressureProposal
  readonly parent: IntrinsicPressureMeasuredLayout
  readonly proposalIdentity: string | undefined
  readonly proposalEvaluation: IntrinsicSeparationEvaluation | undefined
  readonly proposalDispersion: number | undefined
  readonly evaluationCount: number
  readonly bestRepairedLoss: number | undefined
  readonly bestEndpoint: IntrinsicPressureExactEndpoint | undefined
  readonly outcome: 'accepted' | 'rejected'
  readonly reason: string
  readonly retainedPressureIdentity: string | undefined
  readonly preProjectionCompactness: IntrinsicPressureCompactnessTuple | undefined
  readonly canonicalLegalityMemo?: IntrinsicPressureCanonicalLegalityMemo
  readonly repairSweeps?: ReadonlyArray<IntrinsicContractedPressureSweepTrace>
}): IntrinsicContractedPressureAttemptTrace {
  return {
    attemptIndex: input.attemptIndex,
    ratioScheduleIndex: input.ratioScheduleIndex,
    parentCompactness: input.parent.compactness,
    occupiedBox: input.proposal.occupiedBox,
    contractedBox: input.proposal.contractedBox,
    contractionAxis: input.proposal.contractionAxis,
    contractionRatio: input.proposal.contractionRatio,
    removedWidthMm: input.proposal.removedWidthMm,
    areaWeightedMedianGrid: input.proposal.areaWeightedMedianGrid,
    nearPartitionPieceIds: input.proposal.nearPartitionPieceIds,
    farPartitionPieceIds: input.proposal.farPartitionPieceIds,
    translatedPartitionPieceIds: input.proposal.farPartitionPieceIds,
    proposalIdentity: input.proposalIdentity,
    proposalRawLoss: input.proposalEvaluation?.rawLoss,
    proposalWeightedLoss: input.proposalEvaluation?.weightedLoss,
    proposalDispersion: input.proposalDispersion,
    separationEvaluationCount: input.evaluationCount,
    bestRepairedLoss: input.bestRepairedLoss,
    bestEndpointExact: input.bestEndpoint !== undefined,
    bestEndpointSatExactZero:
      input.bestEndpoint?.canonicalLegality.satExactZeroLoss ?? false,
    bestEndpointCanonicalClassification:
      input.bestEndpoint?.canonicalLegality.classification,
    canonicalLegalityRequestCount: input.canonicalLegalityMemo?.requestCount ?? 0,
    canonicalLegalityEvaluationCount:
      input.canonicalLegalityMemo?.evaluationCount ?? 0,
    canonicalLegalityCacheHitCount:
      input.canonicalLegalityMemo?.cacheHitCount ?? 0,
    canonicalLegalityDisagreementCount:
      input.canonicalLegalityMemo?.disagreementCount ?? 0,
    bestEndpointCompactness: input.bestEndpoint?.measured.compactness,
    outcome: input.outcome,
    reason: input.reason,
    retainedPressureIdentity: input.retainedPressureIdentity,
    preProjectionCompactness: input.preProjectionCompactness,
    postProjectionCompactness: undefined,
    repairSweeps: input.repairSweeps ?? []
  }
}

function pressureContractionBox(
  occupiedBox: IntrinsicPressureBox,
  contractionRatio: number
):
  | {
      readonly axis: IntrinsicPressureAxis
      readonly targetBox: IntrinsicTargetBox
      readonly removedWidthMm: number
    }
  | undefined {
  const axis: IntrinsicPressureAxis =
    occupiedBox.widthMm >= occupiedBox.heightMm ? 'x' : 'y'
  const spanGrid =
    axis === 'x'
      ? occupiedBox.maximumXGrid - occupiedBox.minimumXGrid
      : occupiedBox.maximumYGrid - occupiedBox.minimumYGrid
  const removedGrid = Math.max(1, Math.floor(spanGrid * contractionRatio))
  const contractedGrid = spanGrid - removedGrid
  if (contractedGrid <= 0) return undefined
  return {
    axis,
    targetBox:
      axis === 'x'
        ? { widthMm: fromGrid(contractedGrid), heightMm: occupiedBox.heightMm }
        : { widthMm: occupiedBox.widthMm, heightMm: fromGrid(contractedGrid) },
    removedWidthMm: fromGrid(removedGrid)
  }
}

function pressurePoolEntry(
  state: IntrinsicRelaxedState,
  evaluation: IntrinsicSeparationEvaluation,
  key: string | undefined,
  pressureGeneration?: Omit<
    IntrinsicPressureGenerationProvenance,
    'childStateKey'
  >
): IntrinsicInfeasiblePoolEntry | undefined {
  return key === undefined
    ? undefined
    : {
        searchScope: 'contracted-pressure',
        state,
        evaluation,
        key,
        disruptionLineage: false,
        disruptionLineageProvenance: undefined,
        disruptionProtectedUntilSweep: undefined,
        pressureGeneration: {
          parentStateKey: pressureGeneration?.parentStateKey,
          childStateKey: key,
          generationDepth: pressureGeneration?.generationDepth ?? 0,
          selectedPieceIds: pressureGeneration?.selectedPieceIds ?? [],
          affectedPieceIds: pressureGeneration?.affectedPieceIds ?? [],
          lineageAffectedPieceIds: pressureGeneration?.lineageAffectedPieceIds ?? [],
          proposalKind: pressureGeneration?.proposalKind
        }
      }
}

const INTRINSIC_PRESSURE_TRACE_CONFLICT_LIMIT = 5

export function describeIntrinsicPressureLossSnapshot(
  entry: IntrinsicInfeasiblePoolEntry | undefined,
  weights: IntrinsicSeparatorWeights
): IntrinsicPressureLossSnapshot | undefined {
  if (entry === undefined) return undefined
  const provenance = entry.pressureGeneration ?? {
    parentStateKey: undefined,
    childStateKey: entry.key,
    generationDepth: 0,
    selectedPieceIds: [],
    affectedPieceIds: [],
    lineageAffectedPieceIds: [],
    proposalKind: undefined
  }
  const conflictedPieceIds = new Set<PieceId>()
  let wallConflictCount = 0
  let pairConflictCount = 0
  for (const conflict of entry.evaluation.conflicts) {
    conflictedPieceIds.add(conflict.firstPieceId)
    if (conflict.secondPieceId !== undefined) {
      conflictedPieceIds.add(conflict.secondPieceId)
    }
    if (conflict.kind === 'wall') wallConflictCount += 1
    else pairConflictCount += 1
  }
  const topConflicts = entry.evaluation.conflicts
    .map((conflict): IntrinsicPressureConflictTrace => ({
      key: conflict.key,
      kind: conflict.kind,
      firstPieceId: conflict.firstPieceId,
      secondPieceId: conflict.secondPieceId,
      normalizedDepth: conflict.normalizedDepth,
      rawDepth: conflict.rawDepth,
      weightedContribution:
        conflict.normalizedDepth *
        conflict.normalizedDepth *
        (weights.byConflictKey.get(conflict.key) ?? 1),
      moveXGrid: conflict.moveXGrid,
      moveYGrid: conflict.moveYGrid,
      wallSide: pressureWallSide(conflict)
    }))
    .toSorted(
      (first, second) =>
        second.weightedContribution - first.weightedContribution ||
        second.normalizedDepth - first.normalizedDepth ||
        first.key.localeCompare(second.key)
    )
    .slice(0, INTRINSIC_PRESSURE_TRACE_CONFLICT_LIMIT)
  return {
    stateKey: entry.key,
    parentStateKey: provenance.parentStateKey,
    childStateKey: provenance.childStateKey,
    generationDepth: provenance.generationDepth,
    selectedPieceIds: provenance.selectedPieceIds,
    affectedPieceIds: provenance.affectedPieceIds,
    affectedPieceCount: provenance.affectedPieceIds.length,
    lineageAffectedPieceIds: provenance.lineageAffectedPieceIds,
    lineageAffectedPieceCount: provenance.lineageAffectedPieceIds.length,
    proposalKind: provenance.proposalKind,
    rawLoss: entry.evaluation.rawLoss,
    weightedLoss: entry.evaluation.conflicts.reduce(
      (loss, conflict) =>
        loss +
        conflict.normalizedDepth *
          conflict.normalizedDepth *
          (weights.byConflictKey.get(conflict.key) ?? 1),
      0
    ),
    wallConflictCount,
    pairConflictCount,
    conflictedPieceCount: conflictedPieceIds.size,
    topConflicts
  }
}

function pressureLossSnapshot(
  entry: IntrinsicInfeasiblePoolEntry | undefined,
  weights: IntrinsicSeparatorWeights
): IntrinsicPressureLossSnapshot | undefined {
  return describeIntrinsicPressureLossSnapshot(entry, weights)
}

function pressureWallSide(
  conflict: IntrinsicSeparationEvaluation['conflicts'][number]
): 'left' | 'right' | 'bottom' | 'top' | undefined {
  if (conflict.kind !== 'wall') return undefined
  const keySide = conflict.key.slice(conflict.key.lastIndexOf(':') + 1)
  if (
    keySide === 'left' ||
    keySide === 'right' ||
    keySide === 'bottom' ||
    keySide === 'top'
  ) {
    return keySide
  }
  if (Math.abs(conflict.moveXGrid) >= Math.abs(conflict.moveYGrid)) {
    if (conflict.moveXGrid > 0) return 'left'
    if (conflict.moveXGrid < 0) return 'right'
  }
  if (conflict.moveYGrid > 0) return 'bottom'
  if (conflict.moveYGrid < 0) return 'top'
  return undefined
}

function pressureWeightUpdates(
  before: IntrinsicSeparatorWeights,
  after: IntrinsicSeparatorWeights
): ReadonlyArray<IntrinsicPressureWeightUpdateTrace> {
  const conflictKeys = new Set([
    ...before.byConflictKey.keys(),
    ...after.byConflictKey.keys()
  ])
  return [...conflictKeys]
    .toSorted((first, second) => first.localeCompare(second))
    .flatMap((conflictKey) => {
      const beforeWeight = before.byConflictKey.get(conflictKey) ?? 1
      const afterWeight = after.byConflictKey.get(conflictKey) ?? 1
      return beforeWeight === afterWeight
        ? []
        : [{ conflictKey, before: beforeWeight, after: afterWeight }]
    })
}

function pressureSweepLocalImprovement(
  startPreGls: IntrinsicPressureLossSnapshot | undefined,
  generatedBestPreGls: IntrinsicPressureLossSnapshot | undefined
): { readonly rawLoss: number; readonly weightedLoss: number } {
  return startPreGls === undefined || generatedBestPreGls === undefined
    ? { rawLoss: 0, weightedLoss: 0 }
    : {
        rawLoss: startPreGls.rawLoss - generatedBestPreGls.rawLoss,
        weightedLoss: startPreGls.weightedLoss - generatedBestPreGls.weightedLoss
      }
}

export function diagnoseIntrinsicPressureInterruptedSweep(input: {
  readonly pool: ReadonlyArray<IntrinsicInfeasiblePoolEntry>
  readonly candidates: ReadonlyArray<IntrinsicInfeasiblePoolEntry>
  readonly generatedCandidates: ReadonlyArray<IntrinsicInfeasiblePoolEntry>
  readonly weights: IntrinsicSeparatorWeights
  readonly startPreGls: IntrinsicPressureLossSnapshot | undefined
  readonly bestRawLossBeforeSweep: number
  readonly bestRepairedLoss: number
  readonly repairSweep: number
  readonly firstBestSweepIndex: number | undefined
  readonly compositeParents: ReadonlyArray<IntrinsicPressureCompositeParentTrace>
}): IntrinsicPressureInterruptedSweepDiagnostics {
  const generatedBestPreGls = pressureLossSnapshot(
    reweightIntrinsicPool(input.generatedCandidates, input.weights).toSorted(
      comparePoolEntriesByRaw
    )[0],
    input.weights
  )
  const candidateRawWinner = reweightIntrinsicPool(
    input.candidates,
    input.weights
  ).toSorted(comparePoolEntriesByRaw)[0]
  const retainedRawWinner = input.pool.toSorted(comparePoolEntriesByRaw)[0]
  const retainedWeightedWinner = input.pool.toSorted(comparePoolEntriesByWeight)[0]
  const preGlsImprovement = pressureSweepLocalImprovement(
    input.startPreGls,
    generatedBestPreGls
  )
  return {
    generatedBestPreGls,
    retainedRawBest: pressureLossSnapshot(retainedRawWinner, input.weights),
    retainedWeightedBest: pressureLossSnapshot(
      retainedWeightedWinner,
      input.weights
    ),
    preGlsImprovementDeltaRawLoss: preGlsImprovement.rawLoss,
    preGlsImprovementDeltaWeightedLoss: preGlsImprovement.weightedLoss,
    firstBestSweepIndex:
      input.bestRepairedLoss < input.bestRawLossBeforeSweep
        ? input.repairSweep
        : input.firstBestSweepIndex,
    rawWinnerStateKey: candidateRawWinner?.key,
    rawWinnerRetained:
      candidateRawWinner !== undefined &&
      input.pool.some(({ key }) => key === candidateRawWinner.key),
    retainedRawWinnerStateKey: retainedRawWinner?.key,
    retainedWeightedWinnerStateKey: retainedWeightedWinner?.key,
    compositeParents: input.compositeParents.map((parentTrace) => ({
      ...parentTrace,
      outerRetentionOutcome: parentTrace.emittedComposite
        ? 'interrupted'
        : parentTrace.outerRetentionOutcome
    }))
  }
}

function mergePressurePieceIds(
  first: ReadonlyArray<PieceId>,
  second: ReadonlyArray<PieceId>
): ReadonlyArray<PieceId> {
  return [...new Set([...first, ...second])].toSorted((a, b) => a.localeCompare(b))
}

function pressureEndpointFromState(input: {
  readonly catalog: IntrinsicTransformCatalog
  readonly targetBox: IntrinsicTargetBox
  readonly state: IntrinsicRelaxedState
  readonly evaluation: IntrinsicSeparationEvaluation
  readonly weights: IntrinsicSeparatorWeights
  readonly canonicalLegalityMemo: IntrinsicPressureCanonicalLegalityMemo
}): IntrinsicPressureExactEndpoint | undefined {
  const placed = provisionalLayoutFromRelaxedState(input.catalog, input.state)
  const stateKey = intrinsicRelaxedStateKey(input.catalog, input.state)
  const canonicalLegality = classifyIntrinsicPressureCanonicalLegality({
    targetBox: input.targetBox,
    catalog: input.catalog,
    state: input.state,
    evaluation: input.evaluation,
    memo: input.canonicalLegalityMemo
  })
  if (placed === undefined || stateKey === undefined || !canonicalLegality.canonicalLegal) {
    return undefined
  }
  const measured = measureIntrinsicPressureCompactness(placed)
  return measured === undefined
    ? undefined
    : {
        placed,
        state: input.state,
        stateKey,
        targetBox: input.targetBox,
        evaluation: input.evaluation,
        weights: input.weights,
        measured,
        canonicalLegality
      }
}

function addExactPressureEndpoint(
  endpoints: IntrinsicPressureExactEndpoint[],
  candidate: IntrinsicPressureExactEndpoint | undefined
): void {
  if (candidate === undefined) return
  const existingIndex = endpoints.findIndex(
    ({ measured }) =>
      measured.compactness.canonicalIdentity ===
      candidate.measured.compactness.canonicalIdentity
  )
  if (existingIndex < 0) {
    endpoints.push(candidate)
    return
  }
  const existing = endpoints[existingIndex]
  if (existing !== undefined && comparePressureEndpoints(candidate, existing) < 0) {
    endpoints.splice(existingIndex, 1, candidate)
  }
}

function comparePressureEndpoints(
  first: IntrinsicPressureExactEndpoint,
  second: IntrinsicPressureExactEndpoint
): number {
  const a = first.measured.compactness
  const b = second.measured.compactness
  return (
    a.envelopeMaximumSideMm - b.envelopeMaximumSideMm ||
    a.envelopeAreaMm2 - b.envelopeAreaMm2 ||
    a.areaWeightedCentroidDispersion - b.areaWeightedCentroidDispersion ||
    a.enclosedCavityCount - b.enclosedCavityCount ||
    a.largestOccupiedHullGapRatio - b.largestOccupiedHullGapRatio ||
    a.canonicalIdentity.localeCompare(b.canonicalIdentity)
  )
}

function pressureEndpointRejectionReason(
  parent: IntrinsicPressureMeasuredLayout,
  endpoint: IntrinsicPressureExactEndpoint | undefined
): string | undefined {
  if (endpoint === undefined) return undefined
  return intrinsicPressureEndpointRejectionReason(
    parent.compactness,
    endpoint.measured.compactness
  )
}

export function intrinsicPressureEndpointRejectionReason(
  before: IntrinsicPressureCompactnessTuple,
  after: IntrinsicPressureCompactnessTuple
): string | undefined {
  if (after.canonicalIdentity === before.canonicalIdentity) {
    return 'the exact endpoint was canonically identical to its parent'
  }
  if (!(after.envelopeMaximumSideMm < before.envelopeMaximumSideMm)) {
    return 'the exact endpoint did not strictly reduce occupied maximum side'
  }
  if (!(after.envelopeAreaMm2 < before.envelopeAreaMm2)) {
    return 'the exact endpoint did not strictly reduce envelope area'
  }
  if (!(after.areaWeightedCentroidDispersion < before.areaWeightedCentroidDispersion)) {
    return 'the exact endpoint did not strictly reduce centroid dispersion'
  }
  if (after.enclosedCavityCount > before.enclosedCavityCount) {
    return 'the exact endpoint increased enclosed cavities'
  }
  if (after.largestOccupiedHullGapRatio > before.largestOccupiedHullGapRatio) {
    return 'the exact endpoint increased largest occupied hull-gap ratio'
  }
  return undefined
}

function bottomLeftAnchoredPressureLayout(
  placed: ReadonlyArray<IrregularPlacedPiece>
): ReadonlyArray<IrregularPlacedPiece> | undefined {
  return new IrregularBeamState({
    remainingPreparedPieces: [],
    placedCollisionGeometries: placed,
    placementOrder: placed.map(placedPieceId)
  }).withBottomLeftAnchored()?.placedCollisionGeometries
}

interface CanonicalPlacedPolygonMoment {
  readonly pieceId: PieceId
  readonly areaGrid2: number
  readonly centroidXGrid: number
  readonly centroidYGrid: number
}

function canonicalPlacedPolygonMoments(
  placed: ReadonlyArray<IrregularPlacedPiece>
): ReadonlyArray<CanonicalPlacedPolygonMoment> | undefined {
  const canonicalPolygons: Array<{
    readonly pieceId: PieceId
    readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>
  }> = []
  let globalMinimumX = Number.POSITIVE_INFINITY
  let globalMinimumY = Number.POSITIVE_INFINITY
  for (const entry of placed) {
    const translateXGrid = toGridMm(entry.placement.transform.translateX)
    const translateYGrid = toGridMm(entry.placement.transform.translateY)
    if (translateXGrid === undefined || translateYGrid === undefined) return undefined
    const points: Array<{ readonly x: number; readonly y: number }> = []
    for (const point of entry.collisionGeometry.polygon.points) {
      const localX = toGridMm(point.x)
      const localY = toGridMm(point.y)
      if (localX === undefined || localY === undefined) return undefined
      const x = localX + translateXGrid
      const y = localY + translateYGrid
      globalMinimumX = Math.min(globalMinimumX, x)
      globalMinimumY = Math.min(globalMinimumY, y)
      points.push({ x, y })
    }
    if (points.length < 3) return undefined
    canonicalPolygons.push({ pieceId: placedPieceId(entry), points })
  }
  if (
    !Number.isFinite(globalMinimumX) ||
    !Number.isFinite(globalMinimumY) ||
    new Set(canonicalPolygons.map(({ pieceId }) => pieceId)).size !==
      canonicalPolygons.length
  ) {
    return undefined
  }
  const moments: CanonicalPlacedPolygonMoment[] = []
  for (const entry of canonicalPolygons.toSorted((first, second) =>
    first.pieceId.localeCompare(second.pieceId)
  )) {
    const points = entry.points.map(({ x, y }) => ({
      x: x - globalMinimumX,
      y: y - globalMinimumY
    }))
    let doubleSignedArea = 0
    let centroidNumeratorX = 0
    let centroidNumeratorY = 0
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index]
      const next = points[(index + 1) % points.length]
      if (current === undefined || next === undefined) return undefined
      const cross = current.x * next.y - next.x * current.y
      doubleSignedArea += cross
      centroidNumeratorX += (current.x + next.x) * cross
      centroidNumeratorY += (current.y + next.y) * cross
    }
    if (!Number.isFinite(doubleSignedArea) || doubleSignedArea === 0) return undefined
    const areaGrid2 = Math.abs(doubleSignedArea) / 2
    const centroidXGrid = centroidNumeratorX / (3 * doubleSignedArea)
    const centroidYGrid = centroidNumeratorY / (3 * doubleSignedArea)
    if (![areaGrid2, centroidXGrid, centroidYGrid].every(Number.isFinite)) {
      return undefined
    }
    moments.push({
      pieceId: entry.pieceId,
      areaGrid2,
      centroidXGrid,
      centroidYGrid
    })
  }
  return moments.length === placed.length ? moments : undefined
}

function measureIntrinsicAreaWeightedCentroidDispersion(
  placed: ReadonlyArray<IrregularPlacedPiece>
): number | undefined {
  const moments = canonicalPlacedPolygonMoments(placed)
  if (moments === undefined || moments.length === 0) return undefined
  const totalArea = moments.reduce((sum, entry) => sum + entry.areaGrid2, 0)
  if (!Number.isFinite(totalArea) || totalArea <= 0) return undefined
  const centerX =
    moments.reduce(
      (sum, entry) => sum + entry.areaGrid2 * entry.centroidXGrid,
      0
    ) / totalArea
  const centerY =
    moments.reduce(
      (sum, entry) => sum + entry.areaGrid2 * entry.centroidYGrid,
      0
    ) / totalArea
  const weightedSquaredDistance = moments.reduce((sum, entry) => {
    const deltaX = entry.centroidXGrid - centerX
    const deltaY = entry.centroidYGrid - centerY
    return sum + entry.areaGrid2 * (deltaX * deltaX + deltaY * deltaY)
  }, 0)
  const dispersion = weightedSquaredDistance / (totalArea * totalArea)
  return Number.isFinite(dispersion) && dispersion >= 0 ? dispersion : undefined
}

function canonicalPressureBox(
  placed: ReadonlyArray<IrregularPlacedPiece>
): IntrinsicPressureBox | undefined {
  const points = placed.flatMap((entry) =>
    entry.collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: toGridMm(x + entry.placement.transform.translateX),
      y: toGridMm(y + entry.placement.transform.translateY)
    }))
  )
  if (
    points.length === 0 ||
    points.some(({ x, y }) => x === undefined || y === undefined)
  ) {
    return undefined
  }
  const finite = points.filter(
    (point): point is { readonly x: number; readonly y: number } =>
      point.x !== undefined && point.y !== undefined
  )
  const minimumXGrid = Math.min(...finite.map(({ x }) => x))
  const minimumYGrid = Math.min(...finite.map(({ y }) => y))
  const maximumXGrid = Math.max(...finite.map(({ x }) => x))
  const maximumYGrid = Math.max(...finite.map(({ y }) => y))
  return {
    minimumXGrid,
    minimumYGrid,
    maximumXGrid,
    maximumYGrid,
    widthMm: fromGrid(maximumXGrid - minimumXGrid),
    heightMm: fromGrid(maximumYGrid - minimumYGrid)
  }
}

function pressureProjectionCandidate(
  endpoint: IntrinsicPressureExactEndpoint,
  targetRole: IntrinsicGlobalTargetRole | undefined
): IntrinsicProjectionLaneCandidate | undefined {
  return targetRole === undefined
    ? undefined
    : {
        targetRole,
        basinIndex: 0,
        targetBox: endpoint.targetBox,
        entry: {
          searchScope: 'contracted-pressure',
          state: endpoint.state,
          evaluation: endpoint.evaluation,
          key: endpoint.stateKey,
          disruptionLineage: false,
          disruptionLineageProvenance: undefined,
          disruptionProtectedUntilSweep: undefined
        },
        weights: endpoint.weights
      }
}

function recordContractedPressureProjection(
  trace: ReadonlyArray<IntrinsicContractedPressureAttemptTrace>,
  postProjection: IntrinsicPressureMeasuredLayout | undefined
): ReadonlyArray<IntrinsicContractedPressureAttemptTrace> {
  let updated = false
  return [...trace].reverse().map((entry) => {
    if (updated || entry.preProjectionCompactness === undefined) return entry
    updated = true
    return {
      ...entry,
      postProjectionCompactness: postProjection?.compactness
    }
  }).reverse()
}

export function pressureProjectionPreserved(
  before: IntrinsicPressureCompactnessTuple | undefined,
  after: IntrinsicPressureCompactnessTuple | undefined
): boolean {
  return (
    before !== undefined &&
    after !== undefined &&
    before.canonicalIdentity === after.canonicalIdentity
  )
}

/** Preregistered E5 lane selection over completed basin pools, without generic backfill. */
export function selectIntrinsicProjectionWorkItems(
  candidates: ReadonlyArray<IntrinsicProjectionLaneCandidate>,
  targetRoles: ReadonlyArray<IntrinsicGlobalTargetRole>,
  contractedPressureCandidate?: IntrinsicProjectionLaneCandidate,
  preselectedWorkIdentities: ReadonlySet<string> = new Set()
): IntrinsicProjectionWorkSelection {
  const distinctCandidates = new Map<string, IntrinsicProjectionLaneCandidate>()
  for (const candidate of candidates) {
    const identity = projectionWorkIdentity(candidate)
    const existing = distinctCandidates.get(identity)
    if (existing === undefined || compareProjectionCandidateRaw(candidate, existing) < 0) {
      distinctCandidates.set(identity, candidate)
    }
  }
  const available = [...distinctCandidates.values()]
  const selected: IntrinsicProjectionWorkItem[] = []
  const trace: IntrinsicProjectionLaneTrace[] = []
  const selectedIdentities = new Set(preselectedWorkIdentities)

  const registerLane = (
    lane: IntrinsicProjectionLane,
    requestedTargetRoleId: IntrinsicGlobalTargetRole['id'] | undefined,
    eligibleCandidates: ReadonlyArray<IntrinsicProjectionLaneCandidate>
  ): void => {
    if (eligibleCandidates.length === 0) {
      trace.push(unavailableProjectionLaneTrace(lane, requestedTargetRoleId))
      return
    }
    let skippedDuplicateCount = 0
    const candidate = eligibleCandidates.find((eligible) => {
      if (selectedIdentities.has(projectionWorkIdentity(eligible))) {
        skippedDuplicateCount += 1
        return false
      }
      return true
    })
    if (candidate === undefined) {
      const collapsed = projectionWorkItem(
        lane,
        requestedTargetRoleId,
        eligibleCandidates[0] as IntrinsicProjectionLaneCandidate
      )
      trace.push({
        ...projectionLaneTraceFromWork(collapsed),
        outcome: 'lane-collapsed',
        collapsedIntoWorkIdentity: collapsed.workIdentity,
        eligibleCandidateCount: eligibleCandidates.length,
        skippedDuplicateCount
      })
      return
    }
    const workItem = projectionWorkItem(lane, requestedTargetRoleId, candidate)
    selectedIdentities.add(workItem.workIdentity)
    selected.push(workItem)
    trace.push({
      ...projectionLaneTraceFromWork(workItem),
      outcome: 'selected',
      collapsedIntoWorkIdentity: undefined,
      eligibleCandidateCount: eligibleCandidates.length,
      skippedDuplicateCount
    })
  }

  if (contractedPressureCandidate !== undefined) {
    const pressureIdentity = projectionWorkIdentity(contractedPressureCandidate)
    if (!preselectedWorkIdentities.has(pressureIdentity)) {
      registerLane('contracted-pressure', undefined, [contractedPressureCandidate])
    }
  }
  const raw = available.toSorted(compareProjectionCandidateRaw)[0]
  registerLane('global-raw', undefined, raw === undefined ? [] : [raw])
  if (contractedPressureCandidate === undefined) {
    registerLane(
      'global-final-gls',
      undefined,
      available.toSorted(compareProjectionCandidateWeighted)
    )
  }
  for (const role of targetRoles) {
    const disruption = available
      .filter(
        ({ targetRole, entry }) =>
          targetRole.id === role.id && entry.disruptionLineage
      )
      .toSorted(compareProjectionRoleLineageCandidate)
    registerLane('role-disruption', role.id, disruption)
  }

  return { workItems: selected.slice(0, 5), trace }
}

function projectionWorkIdentity(candidate: IntrinsicProjectionLaneCandidate): string {
  return `${candidate.targetRole.id}:${candidate.basinIndex}:${candidate.entry.key}`
}

function compareProjectionCandidateRaw(
  first: IntrinsicProjectionLaneCandidate,
  second: IntrinsicProjectionLaneCandidate
): number {
  return (
    comparePoolEntriesByRaw(first.entry, second.entry) ||
    first.targetRole.id.localeCompare(second.targetRole.id) ||
    first.basinIndex - second.basinIndex ||
    first.entry.key.localeCompare(second.entry.key)
  )
}

function compareProjectionCandidateWeighted(
  first: IntrinsicProjectionLaneCandidate,
  second: IntrinsicProjectionLaneCandidate
): number {
  return (
    comparePoolEntriesByWeight(first.entry, second.entry) ||
    first.targetRole.id.localeCompare(second.targetRole.id) ||
    first.basinIndex - second.basinIndex ||
    first.entry.key.localeCompare(second.entry.key)
  )
}

function compareProjectionRoleLineageCandidate(
  first: IntrinsicProjectionLaneCandidate,
  second: IntrinsicProjectionLaneCandidate
): number {
  return (
    first.entry.evaluation.weightedLoss - second.entry.evaluation.weightedLoss ||
    first.entry.evaluation.rawLoss - second.entry.evaluation.rawLoss ||
    first.entry.key.localeCompare(second.entry.key) ||
    first.basinIndex - second.basinIndex ||
    compareDisruptionLineageProvenance(
      first.entry.disruptionLineageProvenance,
      second.entry.disruptionLineageProvenance
    )
  )
}

function projectionWorkItem(
  lane: IntrinsicProjectionLane,
  requestedTargetRoleId: IntrinsicGlobalTargetRole['id'] | undefined,
  candidate: IntrinsicProjectionLaneCandidate
): IntrinsicProjectionWorkItem {
  return {
    lane,
    requestedTargetRoleId,
    targetRole: candidate.targetRole,
    basinIndex: candidate.basinIndex,
    targetBox: candidate.targetBox,
    state: candidate.entry.state,
    stateKey: candidate.entry.key,
    evaluation: candidate.entry.evaluation,
    weights: candidate.weights,
    disruptionLineage: candidate.entry.disruptionLineage,
    disruptionLineageProvenance: candidate.entry.disruptionLineageProvenance,
    workIdentity: projectionWorkIdentity(candidate)
  }
}

function projectionLaneTraceFromWork(
  workItem: IntrinsicProjectionWorkItem
): Omit<
  IntrinsicProjectionLaneTrace,
  'outcome' | 'collapsedIntoWorkIdentity' | 'eligibleCandidateCount' | 'skippedDuplicateCount'
> {
  return {
    lane: workItem.lane,
    requestedTargetRoleId: workItem.requestedTargetRoleId,
    workIdentity: workItem.workIdentity,
    targetRoleId: workItem.targetRole.id,
    basinIndex: workItem.basinIndex,
    stateKey: workItem.stateKey,
    disruptionLineage: workItem.disruptionLineage,
    disruptionLineageProvenance: workItem.disruptionLineageProvenance,
    rawLoss: workItem.evaluation.rawLoss,
    weightedLoss: workItem.evaluation.weightedLoss
  }
}

function unavailableProjectionLaneTrace(
  lane: IntrinsicProjectionLane,
  requestedTargetRoleId: IntrinsicGlobalTargetRole['id'] | undefined
): IntrinsicProjectionLaneTrace {
  return {
    lane,
    requestedTargetRoleId,
    outcome: 'lane-unavailable',
    workIdentity: undefined,
    collapsedIntoWorkIdentity: undefined,
    targetRoleId: undefined,
    basinIndex: undefined,
    stateKey: undefined,
    disruptionLineage: undefined,
    disruptionLineageProvenance: undefined,
    rawLoss: undefined,
    weightedLoss: undefined,
    eligibleCandidateCount: 0,
    skippedDuplicateCount: 0
  }
}

export function inheritIntrinsicDisruptionLineage(
  parentLineage: boolean,
  proposalKind: IntrinsicSeparatorProposal['kind']
): boolean {
  return parentLineage || isIntrinsicDisruptionProposalKind(proposalKind)
}

export function advanceIntrinsicDisruptionLineage(
  parent: Pick<
    IntrinsicInfeasiblePoolEntry,
    'disruptionLineage' | 'disruptionLineageProvenance'
  >,
  proposalKind: IntrinsicSeparatorProposal['kind'],
  sweepIndex: number,
  stateKey: string
): IntrinsicDisruptionLineageProvenance | undefined {
  if (parent.disruptionLineage && parent.disruptionLineageProvenance !== undefined) {
    return {
      ...parent.disruptionLineageProvenance,
      depth: parent.disruptionLineageProvenance.depth + 1
    }
  }
  return isIntrinsicDisruptionProposalKind(proposalKind)
    ? {
        originSweep: sweepIndex,
        originProposalKind: proposalKind,
        originStateKey: stateKey,
        depth: 0
      }
    : undefined
}

function isIntrinsicDisruptionProposalKind(
  proposalKind: IntrinsicSeparatorProposal['kind']
): proposalKind is IntrinsicDisruptionProposalKind {
  return (
    proposalKind === 'swap' ||
    proposalKind === 'group-transport' ||
    proposalKind === 'split-squeeze' ||
    proposalKind === 'interface-disrupt'
  )
}

function emptyDirectDisruptionProposalCounts(): IntrinsicDirectDisruptionProposalCounts {
  return { swap: 0, groupTransport: 0, splitSqueeze: 0, interfaceDisrupt: 0 }
}

function addDirectDisruptionProposalCounts(
  counts: IntrinsicDirectDisruptionProposalCounts,
  proposals: ReadonlyArray<IntrinsicSeparatorProposal>
): IntrinsicDirectDisruptionProposalCounts {
  let swap = counts.swap
  let groupTransport = counts.groupTransport
  let splitSqueeze = counts.splitSqueeze
  let interfaceDisrupt = counts.interfaceDisrupt
  for (const { kind } of proposals) {
    switch (kind) {
      case 'swap':
        swap += 1
        break
      case 'group-transport':
        groupTransport += 1
        break
      case 'split-squeeze':
        splitSqueeze += 1
        break
      case 'interface-disrupt':
        interfaceDisrupt += 1
        break
      default:
        break
    }
  }
  return { swap, groupTransport, splitSqueeze, interfaceDisrupt }
}

function projectionAttemptTraceBase(
  workItem: IntrinsicProjectionWorkItem,
  completedBasinCount: number,
  completedSweepCount: number,
  projectionAttempt: number
): Omit<
  IntrinsicProjectionAttemptTrace,
  | 'outcome'
  | 'failedPieceId'
  | 'dilationSteps'
  | 'structuralCanonicalGeometryIdentity'
  | 'handoffRetention'
> {
  return {
    lane: workItem.lane,
    requestedTargetRoleId: workItem.requestedTargetRoleId,
    targetRoleId: workItem.targetRole.id,
    basinIndex: workItem.basinIndex,
    stateKey: workItem.stateKey,
    disruptionLineage: workItem.disruptionLineage,
    disruptionLineageProvenance: workItem.disruptionLineageProvenance,
    completedBasinCount,
    completedSweepCount,
    projectionAttempt,
    rawLoss: workItem.evaluation.rawLoss,
    weightedLoss: workItem.evaluation.weightedLoss,
    conflictCount: workItem.evaluation.conflicts.length
  }
}

function addStructuralHandoff(
  handoffs: IntrinsicStructuralHandoff[],
  candidate: IntrinsicStructuralHandoff,
  capacity: number
): IntrinsicStructuralHandoffRetentionTrace {
  const boundedCapacity = Math.max(0, capacity)
  const candidateDiagnostic = structuralHandoffDiagnostic(candidate)
  const existingIndex = handoffs.findIndex(
    ({ metrics }) =>
      metrics.canonicalGeometryIdentity === candidate.metrics.canonicalGeometryIdentity
  )
  if (existingIndex >= 0) {
    const existing = handoffs[existingIndex]
    if (existing !== undefined && compareStructuralHandoffs(candidate, existing) < 0) {
      handoffs.splice(existingIndex, 1, candidate)
      handoffs.sort(compareStructuralHandoffs)
      handoffs.splice(boundedCapacity)
      return structuralRetentionTrace(
        'duplicate-replaced',
        candidateDiagnostic,
        structuralHandoffDiagnostic(candidate),
        structuralHandoffDiagnostic(existing),
        handoffs
      )
    }
    return structuralRetentionTrace(
      'duplicate-discarded',
      candidateDiagnostic,
      existing === undefined ? undefined : structuralHandoffDiagnostic(existing),
      candidateDiagnostic,
      handoffs
    )
  }

  handoffs.push(candidate)
  handoffs.sort(compareStructuralHandoffs)
  const pruned = handoffs.splice(boundedCapacity)[0]
  const retained = handoffs.includes(candidate)
  return structuralRetentionTrace(
    retained ? 'retained' : 'capacity-pruned',
    candidateDiagnostic,
    retained ? candidateDiagnostic : undefined,
    pruned === undefined ? undefined : structuralHandoffDiagnostic(pruned),
    handoffs
  )
}

/** Bounded canonical-identity structural archive with truthful retention diagnostics. */
export function retainIntrinsicStructuralHandoffsWithDiagnostics(
  candidates: ReadonlyArray<IntrinsicStructuralHandoff>,
  capacity: number
): {
  readonly handoffs: ReadonlyArray<IntrinsicStructuralHandoff>
  readonly trace: ReadonlyArray<IntrinsicStructuralHandoffRetentionTrace>
} {
  const handoffs: IntrinsicStructuralHandoff[] = []
  const trace = candidates.map((candidate) =>
    addStructuralHandoff(handoffs, candidate, capacity)
  )
  return { handoffs: [...handoffs], trace }
}

/** Bounded canonical-identity structural archive seam. */
export function retainIntrinsicStructuralHandoffs(
  candidates: ReadonlyArray<IntrinsicStructuralHandoff>,
  capacity: number
): ReadonlyArray<IntrinsicStructuralHandoff> {
  return retainIntrinsicStructuralHandoffsWithDiagnostics(candidates, capacity).handoffs
}

function structuralHandoffDiagnostic(
  handoff: IntrinsicStructuralHandoff
): IntrinsicStructuralHandoffDiagnostic {
  return {
    canonicalGeometryIdentity: handoff.metrics.canonicalGeometryIdentity,
    targetRoleId: handoff.targetRoleId,
    basinIndex: handoff.basinIndex,
    projectionAttempt: handoff.projectionAttempt,
    metrics: { ...handoff.metrics }
  }
}

function structuralRetentionTrace(
  outcome: IntrinsicStructuralHandoffRetentionTrace['outcome'],
  candidate: IntrinsicStructuralHandoffDiagnostic,
  representative: IntrinsicStructuralHandoffDiagnostic | undefined,
  pruned: IntrinsicStructuralHandoffDiagnostic | undefined,
  handoffs: ReadonlyArray<IntrinsicStructuralHandoff>
): IntrinsicStructuralHandoffRetentionTrace {
  return {
    outcome,
    candidate,
    representative,
    pruned,
    retainedCanonicalGeometryIdentities: handoffs.map(
      ({ metrics }) => metrics.canonicalGeometryIdentity
    )
  }
}

function compareStructuralHandoffs(
  first: IntrinsicStructuralHandoff,
  second: IntrinsicStructuralHandoff
): number {
  return (
    first.metrics.enclosedCavityCount - second.metrics.enclosedCavityCount ||
    first.metrics.largestOccupiedHullGapRatio - second.metrics.largestOccupiedHullGapRatio ||
    first.metrics.envelopeAreaMm2 - second.metrics.envelopeAreaMm2 ||
    first.metrics.envelopeMaximumSideMm - second.metrics.envelopeMaximumSideMm ||
    first.metrics.envelopeSpanMm - second.metrics.envelopeSpanMm ||
    first.metrics.totalEnclosedCavityAreaMm2 - second.metrics.totalEnclosedCavityAreaMm2 ||
    first.metrics.occupiedHullWasteRatio - second.metrics.occupiedHullWasteRatio ||
    first.metrics.canonicalGeometryIdentity.localeCompare(
      second.metrics.canonicalGeometryIdentity
    )
  )
}

/** Width-bounded raw, direct-disruption, GLS, active-lineage, and Pareto retention. */
export function retainIntrinsicInfeasiblePool(
  candidates: ReadonlyArray<IntrinsicInfeasiblePoolEntry>,
  capacity: number,
  weights: IntrinsicSeparatorWeights,
  sweepIndex: number
): ReadonlyArray<IntrinsicInfeasiblePoolEntry> {
  return retainIntrinsicInfeasiblePoolWithDiagnostics(
    candidates,
    capacity,
    weights,
    sweepIndex
  ).pool
}

export function retainIntrinsicInfeasiblePoolWithDiagnostics(
  candidates: ReadonlyArray<IntrinsicInfeasiblePoolEntry>,
  capacity: number,
  weights: IntrinsicSeparatorWeights,
  sweepIndex: number
): IntrinsicInfeasiblePoolRetention {
  const boundedCapacity = Math.max(1, capacity)
  const reweighted = reweightIntrinsicPool(candidates, weights)
  const unique = new Map<string, IntrinsicInfeasiblePoolEntry>()
  for (const candidate of reweighted) {
    const existing = unique.get(candidate.key)
    if (existing === undefined) {
      unique.set(candidate.key, candidate)
      continue
    }
    const preferred =
      compareDuplicatePoolEntries(candidate, existing, sweepIndex) < 0
        ? candidate
        : existing
    unique.set(candidate.key, {
      ...preferred,
      disruptionLineage: candidate.disruptionLineage || existing.disruptionLineage,
      disruptionLineageProvenance: preferredDisruptionLineageProvenance(
        candidate,
        existing
      )
    })
  }
  const values = [...unique.values()]
  const rawRanked = values.toSorted(comparePoolEntriesByRaw)
  const weightedRanked = values.toSorted(comparePoolEntriesByWeight)
  const protectedRanked = values
    .filter(
      ({ disruptionProtectedUntilSweep }) =>
        disruptionProtectedUntilSweep !== undefined &&
        disruptionProtectedUntilSweep >= sweepIndex
    )
    .toSorted(comparePoolEntriesByWeight)
  const lineageRanked = values
    .filter(({ disruptionLineage }) => disruptionLineage)
    .toSorted(compareActiveLineageEntries)
  const pareto = values
    .filter(
      (candidate) =>
        !values.some(
          (other) =>
            other.key !== candidate.key && dominatesPoolEntry(other, candidate)
        )
    )
    .toSorted(comparePoolEntriesByRaw)
  const selected: IntrinsicInfeasiblePoolEntry[] = []
  addUniquePoolEntry(selected, rawRanked[0], boundedCapacity)
  addUniquePoolEntry(selected, protectedRanked[0], boundedCapacity)
  addUniquePoolEntry(selected, weightedRanked[0], boundedCapacity)
  const distinctActiveLineage = lineageRanked.find(
    (candidate) => !selected.some(({ key }) => key === candidate.key)
  )
  let activeLineageRetentionOutcome: IntrinsicInfeasiblePoolRetention['activeLineageRetentionOutcome']
  let activeLineageRetentionReason: string
  let reservedLineageEntry: IntrinsicInfeasiblePoolEntry | undefined
  if (lineageRanked.length === 0) {
    activeLineageRetentionOutcome = 'lane-unavailable'
    activeLineageRetentionReason = 'no lineage-bearing state survived same-key deduplication'
  } else if (distinctActiveLineage === undefined) {
    activeLineageRetentionOutcome = 'retained-by-prior-lane'
    activeLineageRetentionReason =
      'the best lineage-bearing identity was already retained by an earlier semantic lane'
    reservedLineageEntry = lineageRanked.find((candidate) =>
      selected.some(({ key }) => key === candidate.key)
    )
  } else if (selected.length >= boundedCapacity) {
    activeLineageRetentionOutcome = 'capacity-evicted'
    activeLineageRetentionReason =
      'pool capacity was exhausted by the raw, direct-disruption, and weighted reservations'
    reservedLineageEntry = distinctActiveLineage
  } else {
    addUniquePoolEntry(selected, distinctActiveLineage, boundedCapacity)
    activeLineageRetentionOutcome = 'reserved-active-lineage'
    activeLineageRetentionReason =
      'the best distinct lineage-bearing state received the persistent active reservation'
    reservedLineageEntry = distinctActiveLineage
  }
  for (const candidate of pareto) addUniquePoolEntry(selected, candidate, boundedCapacity)
  for (const candidate of rawRanked) addUniquePoolEntry(selected, candidate, boundedCapacity)
  const rawWinner = rawRanked[0]
  const pool = rawWinner === undefined
    ? []
    : [rawWinner, ...selected.filter(({ key }) => key !== rawWinner.key)]
  return {
    pool,
    preDeduplicationLineageCount: reweighted.filter(({ disruptionLineage }) => disruptionLineage)
      .length,
    postDeduplicationLineageCount: lineageRanked.length,
    retainedLineageCount: pool.filter(({ disruptionLineage }) => disruptionLineage).length,
    reservedLineage:
      reservedLineageEntry === undefined
        ? undefined
        : intrinsicLineageWitnessTrace(reservedLineageEntry),
    activeLineageRetentionOutcome,
    activeLineageRetentionReason
  }
}

function reweightIntrinsicPool(
  candidates: ReadonlyArray<IntrinsicInfeasiblePoolEntry>,
  weights: IntrinsicSeparatorWeights
): ReadonlyArray<IntrinsicInfeasiblePoolEntry> {
  return candidates.map((candidate) => ({
    ...candidate,
    evaluation: {
      ...candidate.evaluation,
      weightedLoss: intrinsicWeightedLoss(candidate.evaluation, weights)
    }
  }))
}

function compareActiveLineageEntries(
  first: IntrinsicInfeasiblePoolEntry,
  second: IntrinsicInfeasiblePoolEntry
): number {
  return (
    first.evaluation.weightedLoss - second.evaluation.weightedLoss ||
    first.evaluation.rawLoss - second.evaluation.rawLoss ||
    first.key.localeCompare(second.key) ||
    compareDisruptionLineageProvenance(
      first.disruptionLineageProvenance,
      second.disruptionLineageProvenance
    )
  )
}

function preferredDisruptionLineageProvenance(
  first: IntrinsicInfeasiblePoolEntry,
  second: IntrinsicInfeasiblePoolEntry
): IntrinsicDisruptionLineageProvenance | undefined {
  const candidates = [
    ...(first.disruptionLineageProvenance === undefined
      ? []
      : [first.disruptionLineageProvenance]),
    ...(second.disruptionLineageProvenance === undefined
      ? []
      : [second.disruptionLineageProvenance])
  ]
  return candidates.toSorted(compareDisruptionLineageProvenance)[0]
}

function compareDisruptionLineageProvenance(
  first: IntrinsicDisruptionLineageProvenance | undefined,
  second: IntrinsicDisruptionLineageProvenance | undefined
): number {
  if (first === undefined) return second === undefined ? 0 : 1
  if (second === undefined) return -1
  return (
    first.originSweep - second.originSweep ||
    disruptionProposalKindOrdinal(first.originProposalKind) -
      disruptionProposalKindOrdinal(second.originProposalKind) ||
    first.originStateKey.localeCompare(second.originStateKey) ||
    first.depth - second.depth
  )
}

function disruptionProposalKindOrdinal(kind: IntrinsicDisruptionProposalKind): number {
  switch (kind) {
    case 'swap':
      return 0
    case 'group-transport':
      return 1
    case 'split-squeeze':
      return 2
    case 'interface-disrupt':
      return 3
  }
}

function intrinsicLineageWitnessTrace(
  entry: IntrinsicInfeasiblePoolEntry
): IntrinsicLineageWitnessTrace | undefined {
  const provenance = entry.disruptionLineageProvenance
  return provenance === undefined
    ? undefined
    : {
        stateKey: entry.key,
        rawLoss: entry.evaluation.rawLoss,
        weightedLoss: entry.evaluation.weightedLoss,
        originSweep: provenance.originSweep,
        originProposalKind: provenance.originProposalKind,
        originStateKey: provenance.originStateKey,
        depth: provenance.depth
      }
}

function updateIntrinsicLineageShadowSnapshot(
  current: IntrinsicLineageWitnessTrace | undefined,
  candidates: ReadonlyArray<IntrinsicInfeasiblePoolEntry>
): {
  readonly snapshot: IntrinsicLineageWitnessTrace | undefined
  readonly outcome: IntrinsicGlobalSweepTrace['shadowLineageSnapshotOutcome']
  readonly reason: string
} {
  const candidate = candidates
    .filter(({ disruptionLineage }) => disruptionLineage)
    .map(intrinsicLineageWitnessTrace)
    .filter((entry): entry is IntrinsicLineageWitnessTrace => entry !== undefined)
    .toSorted(compareLineageWitnessForShadow)[0]
  if (candidate === undefined) {
    return current === undefined
      ? {
          snapshot: undefined,
          outcome: 'lane-unavailable',
          reason: 'the pre-truncation candidate set contained no lineage witness'
        }
      : {
          snapshot: current,
          outcome: 'retained-no-current-lineage',
          reason: 'the earlier shadow witness was retained because this sweep generated none'
        }
  }
  if (current === undefined) {
    return {
      snapshot: candidate,
      outcome: 'initialized',
      reason: 'the first pre-truncation lineage witness initialized the basin shadow'
    }
  }
  if (compareLineageWitnessForShadow(candidate, current) < 0) {
    return {
      snapshot: candidate,
      outcome: 'replaced',
      reason: 'a better raw-loss, weighted-loss, or state-key witness replaced the shadow'
    }
  }
  return {
    snapshot: current,
    outcome: 'retained-earlier-or-better',
    reason: 'the earlier shadow witness won or tied the deterministic witness order'
  }
}

function compareLineageWitnessForShadow(
  first: IntrinsicLineageWitnessTrace,
  second: IntrinsicLineageWitnessTrace
): number {
  return (
    first.rawLoss - second.rawLoss ||
    first.weightedLoss - second.weightedLoss ||
    first.stateKey.localeCompare(second.stateKey)
  )
}

function intrinsicWeightedLoss(
  evaluation: IntrinsicSeparationEvaluation,
  weights: IntrinsicSeparatorWeights
): number {
  return evaluation.conflicts.reduce(
    (sum, conflict) =>
      sum +
      conflict.normalizedDepth *
        conflict.normalizedDepth *
        (weights.byConflictKey.get(conflict.key) ?? 1),
    0
  )
}

function compareDuplicatePoolEntries(
  first: IntrinsicInfeasiblePoolEntry,
  second: IntrinsicInfeasiblePoolEntry,
  sweepIndex: number
): number {
  const firstProtected =
    first.disruptionProtectedUntilSweep !== undefined &&
    first.disruptionProtectedUntilSweep >= sweepIndex
  const secondProtected =
    second.disruptionProtectedUntilSweep !== undefined &&
    second.disruptionProtectedUntilSweep >= sweepIndex
  return (
    Number(secondProtected) - Number(firstProtected) ||
    comparePoolEntriesByRaw(first, second)
  )
}

function comparePoolEntriesByRaw(
  first: IntrinsicInfeasiblePoolEntry,
  second: IntrinsicInfeasiblePoolEntry
): number {
  return (
    first.evaluation.rawLoss - second.evaluation.rawLoss ||
    first.evaluation.weightedLoss - second.evaluation.weightedLoss ||
    first.key.localeCompare(second.key)
  )
}

function comparePoolEntriesByWeight(
  first: IntrinsicInfeasiblePoolEntry,
  second: IntrinsicInfeasiblePoolEntry
): number {
  return (
    first.evaluation.weightedLoss - second.evaluation.weightedLoss ||
    first.evaluation.rawLoss - second.evaluation.rawLoss ||
    first.key.localeCompare(second.key)
  )
}

function dominatesPoolEntry(
  first: IntrinsicInfeasiblePoolEntry,
  second: IntrinsicInfeasiblePoolEntry
): boolean {
  return (
    first.evaluation.rawLoss <= second.evaluation.rawLoss &&
    first.evaluation.weightedLoss <= second.evaluation.weightedLoss &&
    (first.evaluation.rawLoss < second.evaluation.rawLoss ||
      first.evaluation.weightedLoss < second.evaluation.weightedLoss)
  )
}

function addUniquePoolEntry(
  selected: IntrinsicInfeasiblePoolEntry[],
  candidate: IntrinsicInfeasiblePoolEntry | undefined,
  capacity: number
): void {
  if (
    candidate !== undefined &&
    selected.length < capacity &&
    !selected.some(({ key }) => key === candidate.key)
  ) {
    selected.push(candidate)
  }
}

function targetRole(
  id: IntrinsicGlobalTargetRole['id'],
  widthMm: number,
  heightMm: number
): IntrinsicGlobalTargetRole | undefined {
  const widthGrid = floorIntrinsicTargetGrid(widthMm)
  const heightGrid = floorIntrinsicTargetGrid(heightMm)
  if (widthGrid === undefined || heightGrid === undefined) return undefined
  const canonicalWidthMm = fromGrid(widthGrid)
  const canonicalHeightMm = fromGrid(heightGrid)
  return {
    id,
    widthMm: canonicalWidthMm,
    heightMm: canonicalHeightMm,
    areaMm2: canonicalWidthMm * canonicalHeightMm
  }
}

export function floorIntrinsicTargetGrid(valueMm: number): number | undefined {
  if (!Number.isFinite(valueMm) || valueMm <= 0) return undefined
  const nearestGrid = toGridMm(valueMm)
  if (nearestGrid === undefined) return undefined
  const grid = fromGrid(nearestGrid) <= valueMm ? nearestGrid : nearestGrid - 1
  return Number.isSafeInteger(grid) && grid > 0 ? grid : undefined
}

function canonicalPlacedBounds(
  placed: ReadonlyArray<IrregularPlacedPiece>
): { readonly widthMm: number; readonly heightMm: number } | undefined {
  const points = placed.flatMap((entry) =>
    entry.collisionGeometry.polygon.points.map((point) => ({
      x: toGridMm(point.x + entry.placement.transform.translateX),
      y: toGridMm(point.y + entry.placement.transform.translateY)
    }))
  )
  if (
    points.length === 0 ||
    points.some(({ x, y }) => x === undefined || y === undefined)
  ) {
    return undefined
  }
  const complete = points.filter(
    (point): point is { readonly x: number; readonly y: number } =>
      point.x !== undefined && point.y !== undefined
  )
  const minimumX = Math.min(...complete.map(({ x }) => x))
  const minimumY = Math.min(...complete.map(({ y }) => y))
  const maximumX = Math.max(...complete.map(({ x }) => x))
  const maximumY = Math.max(...complete.map(({ y }) => y))
  return {
    widthMm: fromGrid(maximumX - minimumX),
    heightMm: fromGrid(maximumY - minimumY)
  }
}

function assertSheetlessExactFallback(
  placed: ReadonlyArray<IrregularPlacedPiece>
): boolean {
  const state = new IrregularBeamState({
    remainingPreparedPieces: [],
    placedCollisionGeometries: placed,
    placementOrder: placed.map(placedPieceId)
  }).withBottomLeftAnchored()
  const bounds = state?.translatedCollisionBounds
  if (state === undefined || bounds === undefined) return false
  const sheet = new SheetSpec({
    width: Math.max(1, Math.ceil(bounds.width)),
    height: Math.max(1, Math.ceil(bounds.height)),
    label: 'intrinsic-global-e1-fallback-proof'
  })
  return assertCanonicalGridLegalLayout(sheet, state.placedCollisionGeometries)
}

function collisionAreaMm2(piece: IrregularPreparedPiece): number | undefined {
  const points = piece.collisionGeometry.collisionPolygon.points
  if (points.length < 3) return undefined
  let doubleArea = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (current === undefined || next === undefined) return undefined
    doubleArea += current.x * next.y - next.x * current.y
  }
  const area = Math.abs(doubleArea) / 2
  return Number.isFinite(area) && area > 0 ? area : undefined
}

function deterministicOrdinal(seed: number, sweep: number, poolIndex: number): number {
  return Math.abs((seed ^ Math.imul(sweep + 1, 0x45d9f3b) ^ Math.imul(poolIndex + 1, 0x27d4eb2d)) | 0)
}

function hashIntrinsicSeed(value: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

function sameSortedPieceIds(
  first: ReadonlyArray<PieceId>,
  second: ReadonlyArray<PieceId>
): boolean {
  return (
    first.length === second.length &&
    first.every((pieceId, index) => pieceId === second[index])
  )
}

function deadlineControl(
  control: IrregularNfpIfpControl | undefined,
  startedAt: number,
  maximumRuntimeMs: number
): IrregularNfpIfpControl {
  return {
    checkpoint: (phase) =>
      Effect.gen(function* () {
        if (control !== undefined) yield* control.checkpoint(phase)
        if (performance.now() - startedAt >= maximumRuntimeMs) {
          return yield* Effect.fail(
            new IrregularNfpIfpControlAbortError({
              reason: 'deadline',
              message: 'the intrinsic global search reached its cooperative deadline.'
            })
          )
        }
      })
  }
}

function globalSearchCheckpoint(
  control: IrregularNfpIfpControl
): Effect.Effect<'continue' | 'deadline', IrregularNfpIfpControlAbortError> {
  return Effect.matchEffect(control.checkpoint('candidate-points'), {
    onFailure: (error) =>
      error.reason === 'deadline' ? Effect.succeed('deadline' as const) : Effect.fail(error),
    onSuccess: () => Effect.succeed('continue' as const)
  })
}

function globalFailure(
  operation: IntrinsicGlobalSearchError['operation'],
  message: string
): Effect.Effect<never, IntrinsicGlobalSearchError> {
  return Effect.fail(new IntrinsicGlobalSearchError({ operation, message }))
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function placedPieceId(piece: IrregularPlacedPiece): PieceId {
  return piece.placement.pieceId ?? piece.placement.sourcePieceId
}

export type IntrinsicGlobalProjectionError = IntrinsicExactProjectionError
