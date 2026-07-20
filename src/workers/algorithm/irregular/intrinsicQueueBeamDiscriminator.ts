import { Data, Effect, Order } from 'effect'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  booleanOpWithPolyTree,
  ClipType,
  FillRule,
  type Path64,
  polyTreeToPaths64,
  PolyTree64
} from 'clipper2-ts'
import type { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularTransform,
  type IrregularNestingSettings,
  type IrregularPreparedPiece,
  type IrregularTransformCandidate,
  type TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  analyzeCanonicalLayoutStructure,
  assertCanonicalGridLegalLayout,
  measureCanonicalEnclosedCavities,
  measureCanonicalLayoutContacts,
  measureCanonicalLayoutEnvelope,
  measureCanonicalLayoutTopologyExact,
  placedCollisionWorldGridPath
} from '../../irregular/canonicalLayoutGeometry.js'
import { fromGrid, toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularNfpIfpCandidateMemoScope,
  IrregularNfpIfpControlAbortError,
  type IrregularGeometryInputError,
  type IrregularNestingNotImplementedError,
  type IrregularNfpIfpControl,
  type NfpIfpCandidateProvenance,
  type NfpIfpService as NfpIfpServiceShape,
  NfpIfpService
} from '../../irregular/services.js'
import { PlacementValidation } from '../../irregular/placementValidation.js'
import {
  candidateContainedInIntrinsicGap,
  deriveCanonicalIntrinsicGapRegions,
  type CanonicalIntrinsicGapRegion
} from './intrinsicGapRegions.js'
import { intrinsicPreparedPieceClassKey } from './intrinsicReconstructionPortfolio.js'
import { IrregularBeamState } from './irregularBeamState.js'
import {
  IntrinsicStrictDecoderError,
  finalizeIntrinsicStrictState,
  measureIntrinsicStrictCanonicalEnvelope,
  rankIntrinsicStrictCompletedLayouts,
  selectIntrinsicStrictFamilyWinner,
  type IntrinsicStrictCompletedMetrics,
  type IntrinsicStrictLocalScore
} from './intrinsicStrictDecoder.js'

const INTRINSIC_COORDINATE_DOMAIN = new SheetSpec({
  width: 1,
  height: 1,
  label: 'intrinsic-queue-beam-audit-coordinate-domain'
})

const SAME_PIECE_FRONTIER_CONTINUATION_LIMIT = 4
const DEFAULT_WITNESS_LIMIT = 4
const COMMENSURATE_FIRST_STEP_LIMIT = 2
const COMMENSURATE_SECOND_STEP_LIMIT = 2
const PARTIAL_FUTURE_EQUIVALENCE_KEY_VERSION = 'partial-future-equivalence-v1'
const OCCUPIED_DISPERSION_VERSION = 'occupied-dispersion-v1'

const transformCandidateOrder = Order.combineAll<IrregularTransformCandidate>([
  Order.mapInput(Order.Number, (transform) => transform.index),
  Order.mapInput(Order.Number, (transform) => transform.rotationDeg),
  Order.mapInput(Order.Boolean, (transform) => transform.mirrored),
  Order.mapInput(Order.String, (transform) => transform.reason)
])

export type IntrinsicQueueBeamClassification =
  | 'queue-headroom'
  | 'beam-headroom'
  | 'both'
  | 'neither'

export interface IntrinsicQueueBeamAxes {
  readonly compactness: {
    readonly maximumSideGrid: number
    readonly envelopeAreaGrid2: number
    readonly spanGrid: number
  }
  readonly fragmentation: {
    readonly occupiedDoubledAreaOutsideLargestComponentGrid2: number
    readonly isolatedPieceCount: number
    readonly positiveContactComponentCount: number
    readonly negativeLargestPositiveContactComponentSize: number
    readonly totalStructuralContacts: number
    readonly dominantStructuralContacts: number
  }
  readonly voids: {
    readonly enclosedCavityCount: number
    readonly totalEnclosedCavityDoubledAreaGrid2: number
    readonly largestHullGapDoubledAreaGrid2: number
    readonly occupiedHullDoubledAreaGrid2: number
    readonly occupiedHullWasteDoubledAreaGrid2: number
    readonly occupiedDoubledAreaGrid2: number
  }
}

export interface IntrinsicQueueBeamCandidateWitness {
  readonly pieceId: PieceId
  readonly transformFamily: string
  readonly gridPoint: { readonly x: number; readonly y: number }
  readonly canonicalGeometryKey: string
  readonly axes: IntrinsicQueueBeamAxes
}

export interface IntrinsicQueueBeamRankedWitness extends IntrinsicQueueBeamCandidateWitness {
  readonly compactnessRank: number
  readonly fragmentationRank: number
  readonly voidRank: number
  readonly frontierRank: number | undefined
}

export interface IntrinsicQueueBeamStepReport {
  readonly depth: number
  readonly scheduledPieceId: PieceId
  readonly scheduled: {
    readonly generatedCandidateCount: number
    readonly scoredCandidateCount: number
    readonly canonicalLegalCandidateCount: number
    readonly uniqueCanonicalSuccessorCount: number
    readonly nondominatedFrontierSize: number
    readonly selectedCanonicalGeometryKey: string | undefined
    readonly selectedOnCanonicalFrontier: boolean
    readonly selectedRanks:
      | Omit<
          IntrinsicQueueBeamRankedWitness,
          'pieceId' | 'transformFamily' | 'gridPoint' | 'canonicalGeometryKey' | 'axes'
        >
      | undefined
    readonly boundedFrontierWitnesses: ReadonlyArray<IntrinsicQueueBeamRankedWitness>
  }
  readonly queue: {
    readonly distinctRemainingGeometryClassCount: number
    readonly generatedCandidateCount: number
    readonly scoredCandidateCount: number
    readonly canonicalLegalCandidateCount: number
    readonly gapContainedCandidateCount: number
    readonly nonInertGapContainedCandidateCount: number
    readonly paretoHeadroomCandidateCount: number
    readonly dominatesEveryScheduledSuccessorCount: number
    readonly bestParetoOpportunity: IntrinsicQueueBeamCandidateWitness | undefined
    readonly bestStrictImprovement: IntrinsicQueueBeamCandidateWitness | undefined
    readonly bestParetoOpportunityRegressesContactStructure: boolean | undefined
  }
  readonly commensurateQueue: IntrinsicCommensurateQueueReport
  readonly delayedLineage: IntrinsicDelayedLineageStepReport | undefined
  readonly beam: {
    readonly continuationLimit: 4
    readonly rejectedFrontierAlternativeCount: number
    readonly attemptedContinuationCount: number
    readonly successfulContinuationCount: number
    readonly selectedContinuationNoFit: boolean
    readonly paretoHeadroomContinuationCount: number
    readonly dominatingContinuationCount: number
    readonly selectedContinuation: IntrinsicQueueBeamCandidateWitness | undefined
    readonly boundedParetoHeadroomWitnesses: ReadonlyArray<{
      readonly alternative: IntrinsicQueueBeamCandidateWitness
      readonly continuation: IntrinsicQueueBeamCandidateWitness
      readonly contactStructureRegresses: boolean
    }>
  }
  readonly classification: IntrinsicQueueBeamClassification
}

export interface IntrinsicDelayedLineageStepReport {
  readonly expectedCanonicalGeometryKey: string
  readonly generated: boolean
  readonly paretoLayer: number | undefined
  readonly paretoLayerRank: number | undefined
  readonly compactnessRank: number | undefined
  readonly fragmentationRank: number | undefined
  readonly voidRank: number | undefined
  readonly survivesAtTotalCapacities: Readonly<Record<'1' | '2' | '4' | '8' | '13', boolean>>
  readonly survivesAtExperimentalWidths: Readonly<
    Record<'0' | '1' | '3' | '7' | '12', boolean>
  >
  readonly experimentalWidthRoles: Readonly<
    Record<
      '0' | '1' | '3' | '7' | '12',
      'protected' | IntrinsicPartialGeometricBeamRole | 'not-retained'
    >
  >
}

export interface IntrinsicCommensurateQueueOrderReport {
  readonly firstStepCanonicalSuccessorCount: number
  readonly retainedFirstStepCount: number
  readonly completedSuccessorCount: number
  readonly boundedCompletedWitnesses: ReadonlyArray<IntrinsicQueueBeamCandidateWitness>
}

export interface IntrinsicCommensurateQueueReport {
  readonly status: 'no-alternate-class' | 'no-non-inert-alternate' | 'incomplete' | 'completed'
  readonly alternatePieceId: PieceId | undefined
  readonly alternateGeometryClass: string | undefined
  readonly scheduledThenAlternate: IntrinsicCommensurateQueueOrderReport
  readonly alternateThenScheduled: IntrinsicCommensurateQueueOrderReport
  readonly convergedCanonicalSuccessorCount: number
  readonly alternateOrderParetoHeadroomCount: number
  readonly alternateOrderStrictImprovementCount: number
  readonly bestAlternateOrderWitness: IntrinsicQueueBeamCandidateWitness | undefined
}

export interface IntrinsicQueueBeamDiscriminatorResult {
  readonly status: 'completed' | 'truncated'
  readonly truncation:
    | {
        readonly reason: 'maximum-runtime' | 'maximum-evaluations'
        readonly depth: number
      }
    | undefined
  readonly budget: {
    readonly maximumRuntimeMs: number
    readonly maximumEvaluations: number
    readonly evaluations: number
    readonly runtimeMs: number
  }
  readonly selectedLineageFinalCanonicalGeometryKey: string
  readonly completedDepthCount: number
  readonly classificationCounts: Readonly<Record<IntrinsicQueueBeamClassification, number>>
  readonly delayedLineage: {
    readonly provided: boolean
    readonly matchedDepthCount: number
    readonly firstMissingDepth: number | undefined
    readonly minimumObservedSurvivalCapacity: 1 | 2 | 4 | 8 | 13 | undefined
    readonly minimumObservedExperimentalWidth: 0 | 1 | 3 | 7 | 12 | undefined
  }
  readonly steps: ReadonlyArray<IntrinsicQueueBeamStepReport>
}

export interface IntrinsicPartialGeometricBeamResult {
  readonly status: 'completed' | 'incomplete' | 'truncated'
  readonly experimentalWidth: number
  readonly truncationReason: 'maximum-runtime' | 'maximum-evaluations' | undefined
  readonly evaluations: number
  readonly protectedControlEvaluations: number
  readonly experimentalEvaluations: number
  readonly runtimeMs: number
  readonly completedDepthCount: number
  readonly steps: ReadonlyArray<{
    readonly depth: number
    readonly scheduledPieceId: PieceId
    readonly parentCount: number
    readonly parentEnumerations: ReadonlyArray<{
      readonly parentFutureEquivalenceDigest: string
      readonly protectedControl: boolean
      readonly generatedCandidateCount: number
      readonly envelopeEventCandidateCount: number
      readonly scoredCandidateCount: number
      readonly canonicalLegalCandidateCount: number
      readonly uniqueCanonicalSuccessorCount: number
      readonly candidateGenerationRuntimeMs: number
      readonly candidateScoringRuntimeMs: number
      readonly canonicalAdmissionRuntimeMs: number
      readonly runtimeMs: number
    }>
    readonly generatedCandidateCount: number
    readonly envelopeEventCandidateCount: number
    readonly scoredCandidateCount: number
    readonly canonicalLegalCandidateCount: number
    readonly canonicalUniqueSuccessorCount: number
    readonly monotoneFitRejectionCount: number
    readonly uniqueSuccessorCount: number
    readonly futureEquivalenceDeduplicationCount: number
    readonly paretoLayerSizes: ReadonlyArray<number>
    readonly paretoLayerExtractionComplete: boolean
    readonly unlayeredCandidateCount: number
    readonly capacityEvictionCount: number
    readonly protectedControlDigest: string | undefined
    readonly protectedControlSurvived: boolean
    readonly futureEquivalenceKeyVersion: typeof PARTIAL_FUTURE_EQUIVALENCE_KEY_VERSION
    readonly occupiedDispersionVersion: typeof OCCUPIED_DISPERSION_VERSION
    readonly remainingOrderDigest: string
    readonly cumulativeEvaluations: number
    readonly cumulativeRuntimeMs: number
    readonly enumerationRuntimeMs: number
    readonly candidateGenerationRuntimeMs: number
    readonly candidateScoringRuntimeMs: number
    readonly canonicalAdmissionRuntimeMs: number
    readonly selectionRuntimeMs: number
    readonly selectedSlots: ReadonlyArray<IntrinsicPartialGeometricBeamTraceSlot>
  }>
  readonly finalists: ReadonlyArray<{
    readonly futureEquivalenceKey: string
    readonly canonicalGeometryKey: string
    readonly canonicalGeometryHash: string
    readonly terminalRotationDeg: 0 | 90
    readonly metrics: IntrinsicStrictCompletedMetrics
    readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  }>
  readonly winner:
    | {
        readonly futureEquivalenceKey: string
        readonly canonicalGeometryKey: string
        readonly canonicalGeometryHash: string
        readonly terminalRotationDeg: 0 | 90
        readonly metrics: IntrinsicStrictCompletedMetrics
        readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
      }
    | undefined
}

export interface IntrinsicReferenceSuccessorReachabilityAudit {
  readonly pieceId: PieceId
  readonly expectedCanonicalGeometryHash: string
  readonly target: {
    readonly transformFamily: string
    readonly gridX: number
    readonly gridY: number
    readonly parentAlignmentGridX: number
    readonly parentAlignmentGridY: number
  }
  readonly directLegal: boolean
  readonly nfpBoundary: {
    readonly fixedPieceCount: number
    readonly matchingVertexCount: number
    readonly matchingSegmentCount: number
    readonly matchingSegments: ReadonlyArray<{
      readonly start: { readonly x: number; readonly y: number }
      readonly end: { readonly x: number; readonly y: number }
    }>
  }
  readonly envelopeAlignmentEvents: ReadonlyArray<string>
  readonly freshRunsConsistent: boolean
  readonly generatedCandidateCount: number
  readonly exactTargetGenerated: boolean
  readonly exactTargetSourceMask: number | undefined
  readonly envelopeEventCandidateCount: number
  readonly exactTargetEnvelopeEventGenerated: boolean
  readonly nearestGeneratedCandidate:
    | {
        readonly gridX: number
        readonly gridY: number
        readonly squaredGridDistance: number
      }
    | undefined
  readonly targetScored: boolean
  readonly targetCanonicalLegal: boolean
  readonly targetMatchesExpectedCanonicalGeometry: boolean
  readonly classification:
    | 'reachable-exact-successor'
    | 'direct-illegal-historical-pose'
    | 'raw-nfp-vertex-not-emitted'
    | 'missing-finite-boundary-feature'
    | 'not-on-current-nfp-boundary'
    | 'generated-but-scoring-rejected'
    | 'generated-but-canonical-rejected'
    | 'generated-with-canonical-pose-delta'
}

type IntrinsicPartialGeometricBeamRole = 'breadth' | 'contact' | 'dispersion'

interface IntrinsicPartialGeometricBeamTraceSlot {
  readonly role: IntrinsicPartialGeometricBeamRole
  readonly layer: number
  readonly visit: number
  readonly futureEquivalenceDigest: string
  readonly parentFutureEquivalenceDigest: string | undefined
  readonly canonicalGeometryHash: string
  readonly axes: IntrinsicQueueBeamAxes
  readonly dispersion:
    | {
        readonly nearestRetainedFutureEquivalenceDigest: string
        readonly voidHamming: number
        readonly contactHamming: number
        readonly symmetricDifferenceNumerator: string
        readonly pairUnionDenominator: string
        readonly symmetricDifferenceRatio: number
      }
    | undefined
}

export class IntrinsicQueueBeamDiscriminatorError extends Data.TaggedError(
  'IntrinsicQueueBeamDiscriminatorError'
)<{
  readonly operation: 'input' | 'measurement'
  readonly message: string
}> {}

type AuditError =
  | IntrinsicQueueBeamDiscriminatorError
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError

interface AuditBudget {
  readonly startedAt: number
  readonly maximumRuntimeMs: number
  readonly maximumEvaluations: number
  evaluations: number
  truncationReason: 'maximum-runtime' | 'maximum-evaluations' | undefined
}

interface AuditCandidate extends IntrinsicQueueBeamCandidateWitness {
  readonly state: IrregularBeamState
  readonly parentFutureEquivalenceKey: string
  readonly score: IntrinsicStrictLocalScore
  readonly movingCollisionAreaMm2: number
  readonly containingGap: CanonicalIntrinsicGapRegion | undefined
}

type UnmeasuredAuditCandidate = Omit<AuditCandidate, 'axes'>

interface EnumeratedSuccessors {
  readonly generatedCandidateCount: number
  readonly envelopeEventCandidateCount: number
  readonly scoredCandidateCount: number
  readonly canonicalLegalCandidateCount: number
  readonly candidateGenerationRuntimeMs: number
  readonly candidateScoringRuntimeMs: number
  readonly canonicalAdmissionRuntimeMs: number
  readonly uniqueCanonicalSuccessors: ReadonlyArray<AuditCandidate>
  readonly selected: AuditCandidate | undefined
  readonly fullyEnumerated: boolean
}

/**
 * Replays one pure-growth strict construction under independent diagnostic
 * budgets. It never participates in the live decode, ranking, or deadline.
 */
export function runIntrinsicQueueBeamDiscriminator(input: {
  readonly orderedPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly maximumRuntimeMs: number
  readonly maximumEvaluations: number
  readonly maximumWitnesses?: number
  readonly referenceLineageCanonicalGeometryKeys?: ReadonlyArray<string>
}): Effect.Effect<
  IntrinsicQueueBeamDiscriminatorResult,
  AuditError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    if (
      !Number.isFinite(input.maximumRuntimeMs) ||
      input.maximumRuntimeMs <= 0 ||
      !Number.isFinite(input.maximumEvaluations) ||
      input.maximumEvaluations <= 0
    ) {
      return yield* Effect.fail(
        new IntrinsicQueueBeamDiscriminatorError({
          operation: 'input',
          message: 'audit runtime and evaluation budgets must be finite positive values.'
        })
      )
    }
    const startedAt = performance.now()
    const budget: AuditBudget = {
      startedAt,
      maximumRuntimeMs: input.maximumRuntimeMs,
      maximumEvaluations: Math.max(1, Math.floor(input.maximumEvaluations)),
      evaluations: 0,
      truncationReason: undefined
    }
    const maximumWitnesses = Math.max(
      0,
      Math.floor(input.maximumWitnesses ?? DEFAULT_WITNESS_LIMIT)
    )
    const settings = yield* GeometrySettings
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const candidateMemoScope = new IrregularNfpIfpCandidateMemoScope()
    const control: IrregularNfpIfpControl = {
      checkpoint: () =>
        performance.now() - budget.startedAt >= budget.maximumRuntimeMs
          ? Effect.fail(
              new IrregularNfpIfpControlAbortError({
                reason: 'deadline',
                message: `queue-beam audit exceeded ${budget.maximumRuntimeMs} ms.`
              })
            )
          : Effect.void
    }
    let state = IrregularBeamState.empty(input.orderedPreparedPieces)
    let referenceState = IrregularBeamState.empty(input.orderedPreparedPieces)
    const steps: IntrinsicQueueBeamStepReport[] = []
    let truncationDepth = 0
    let firstMissingReferenceDepth: number | undefined

    for (let depth = 0; depth < input.orderedPreparedPieces.length; depth += 1) {
      truncationDepth = depth
      if (auditRuntimeExpired(budget)) break
      const scheduledPiece = input.orderedPreparedPieces[depth]
      if (scheduledPiece === undefined) continue
      const futurePieces = input.orderedPreparedPieces.slice(depth + 1)
      const scheduledOutcome = yield* enumerateWithDeadlineRecovery({
        state,
        piece: scheduledPiece,
        remainingPreparedPieces: futurePieces,
        budget,
        settings,
        geometryKernel,
        nfpIfpService,
        candidateMemoScope,
        control,
        includeEnvelopeEventCandidates: true
      })
      if (scheduledOutcome === undefined || !scheduledOutcome.fullyEnumerated) break
      const scheduledSuccessors = scheduledOutcome.uniqueCanonicalSuccessors
      const frontier = nondominatedFrontier(scheduledSuccessors)
      const ranked = rankWitnesses(scheduledSuccessors, frontier)
      const selectedKey = scheduledOutcome.selected?.canonicalGeometryKey
      const selectedRanked = ranked.find(
        ({ canonicalGeometryKey }) => canonicalGeometryKey === selectedKey
      )
      const expectedReferenceKey = input.referenceLineageCanonicalGeometryKeys?.[depth]
      let delayedLineage: IntrinsicDelayedLineageStepReport | undefined
      if (expectedReferenceKey !== undefined && firstMissingReferenceDepth === undefined) {
        const referenceOutcome = yield* enumerateWithDeadlineRecovery({
          state: referenceState,
          piece: scheduledPiece,
          remainingPreparedPieces: futurePieces,
          budget,
          settings,
          geometryKernel,
          nfpIfpService,
          candidateMemoScope,
          control,
          measureGapContainment: false,
          includeEnvelopeEventCandidates: true
        })
        if (referenceOutcome === undefined || !referenceOutcome.fullyEnumerated) break
        const referenceSuccessors = referenceOutcome.uniqueCanonicalSuccessors
        const referenceCandidate = referenceSuccessors.find(
          ({ canonicalGeometryKey }) => canonicalGeometryKey === expectedReferenceKey
        )
        const referenceLayers = nondominatedLayers(referenceSuccessors)
        const referenceRanked =
          referenceCandidate === undefined
            ? undefined
            : rankWitnesses(referenceSuccessors, referenceLayers[0] ?? []).find(
                ({ canonicalGeometryKey }) => canonicalGeometryKey === expectedReferenceKey
              )
        const referenceLayer = referenceLayers.find((layer) =>
          layer.some(({ canonicalGeometryKey }) => canonicalGeometryKey === expectedReferenceKey)
        )
        const paretoLayerRank =
          referenceLayer === undefined
            ? undefined
            : orderCandidates(referenceLayer).findIndex(
                  ({ canonicalGeometryKey }) => canonicalGeometryKey === expectedReferenceKey
                ) + 1 || undefined
        const capacities = [1, 2, 4, 8, 13] as const
        const experimentalWidths = [0, 1, 3, 7, 12] as const
        const referenceEntries = referenceSuccessors.map(partialBeamEntry)
        const referenceProtected =
          referenceOutcome.selected === undefined
            ? undefined
            : referenceEntries.find(
                ({ canonicalGeometryKey }) =>
                  canonicalGeometryKey === referenceOutcome.selected?.canonicalGeometryKey
              )
        const experimentalWidthRoles = Object.fromEntries(
          experimentalWidths.map((width) => {
            if (referenceProtected?.canonicalGeometryKey === expectedReferenceKey) {
              return [String(width), 'protected']
            }
            const selection = selectIntrinsicPartialGeometricBeam({
              candidates: referenceEntries,
              experimentalWidth: width,
              ...(referenceProtected === undefined
                ? {}
                : { protectedControl: referenceProtected })
            })
            const role = selection.slots.find(
              ({ canonicalGeometryKey }) => canonicalGeometryKey === expectedReferenceKey
            )?.role
            return [String(width), role ?? 'not-retained']
          })
        ) as Record<
          '0' | '1' | '3' | '7' | '12',
          'protected' | IntrinsicPartialGeometricBeamRole | 'not-retained'
        >
        delayedLineage = {
          expectedCanonicalGeometryKey: expectedReferenceKey,
          generated: referenceCandidate !== undefined,
          paretoLayer: findCandidateLayer(referenceLayers, expectedReferenceKey),
          paretoLayerRank,
          compactnessRank: referenceRanked?.compactnessRank,
          fragmentationRank: referenceRanked?.fragmentationRank,
          voidRank: referenceRanked?.voidRank,
          survivesAtTotalCapacities: Object.fromEntries(
            capacities.map((capacity) => [
              String(capacity),
              referenceCandidate !== undefined &&
                selectCalibrationCapacity(
                  referenceSuccessors,
                  referenceOutcome.selected,
                  capacity
                ).some(({ canonicalGeometryKey }) => canonicalGeometryKey === expectedReferenceKey)
            ])
          ) as Record<'1' | '2' | '4' | '8' | '13', boolean>,
          survivesAtExperimentalWidths: Object.fromEntries(
            experimentalWidths.map((width) => [
              String(width),
              referenceCandidate !== undefined &&
                experimentalWidthRoles[String(width) as keyof typeof experimentalWidthRoles] !==
                  'not-retained'
            ])
          ) as Record<'0' | '1' | '3' | '7' | '12', boolean>,
          experimentalWidthRoles
        }
        if (referenceCandidate === undefined) {
          firstMissingReferenceDepth = depth
        } else {
          referenceState = referenceCandidate.state
        }
      }

      const queueCounters = {
        distinctRemainingGeometryClassCount: 0,
        generatedCandidateCount: 0,
        scoredCandidateCount: 0,
        canonicalLegalCandidateCount: 0,
        gapContainedCandidateCount: 0,
        nonInertGapContainedCandidateCount: 0
      }
      const nonInertQueueCandidates: AuditCandidate[] = []
      const remainingClassRepresentatives = distinctGeometryClassRepresentatives(futurePieces)
      queueCounters.distinctRemainingGeometryClassCount = remainingClassRepresentatives.length
      for (const representative of remainingClassRepresentatives) {
        const representativeId = preparedPieceId(representative)
        const representativeIndex = futurePieces.findIndex(
          (piece) => preparedPieceId(piece) === representativeId
        )
        const remainingAfterRepresentative = futurePieces.filter(
          (_, index) => index !== representativeIndex
        )
        const outcome = yield* enumerateWithDeadlineRecovery({
          state,
          piece: representative,
          remainingPreparedPieces: remainingAfterRepresentative,
          budget,
          settings,
          geometryKernel,
          nfpIfpService,
          candidateMemoScope,
          control
        })
        if (outcome === undefined) break
        queueCounters.generatedCandidateCount += outcome.generatedCandidateCount
        queueCounters.scoredCandidateCount += outcome.scoredCandidateCount
        queueCounters.canonicalLegalCandidateCount += outcome.canonicalLegalCandidateCount
        for (const candidate of outcome.uniqueCanonicalSuccessors) {
          if (candidate.containingGap === undefined) continue
          queueCounters.gapContainedCandidateCount += 1
          if (isNonInertGapCandidate(state, candidate)) {
            queueCounters.nonInertGapContainedCandidateCount += 1
            nonInertQueueCandidates.push(candidate)
          }
        }
        if (!outcome.fullyEnumerated) break
      }
      if (budget.truncationReason !== undefined) break

      const paretoQueueCandidates = nonInertQueueCandidates.filter(
        (candidate) => assessIntrinsicQueueCandidate(candidate, scheduledSuccessors).paretoHeadroom
      )
      const dominatingQueueCandidates = paretoQueueCandidates.filter(
        (candidate) =>
          assessIntrinsicQueueCandidate(candidate, scheduledSuccessors).strictImprovement
      )
      const bestQueueOpportunity = orderCandidates(paretoQueueCandidates)[0]
      const bestStrictQueueImprovement = orderCandidates(dominatingQueueCandidates)[0]

      const selectedState =
        scheduledOutcome.selected?.state ??
        state.withUnplacedPiece({
          remainingPreparedPieces: futurePieces,
          unplacedPieceId: preparedPieceId(scheduledPiece)
        })
      const nextPiece = futurePieces[0]
      const continuationTail = futurePieces.slice(1)
      let selectedContinuation: AuditCandidate | undefined
      const paretoHeadroomContinuations: Array<{
        readonly alternative: AuditCandidate
        readonly continuation: AuditCandidate
      }> = []
      let dominatingContinuationCount = 0
      let attemptedContinuationCount = 0
      let successfulContinuationCount = 0
      const rejectedFrontierAlternatives = orderCandidates(
        frontier.filter(({ canonicalGeometryKey }) => canonicalGeometryKey !== selectedKey)
      ).slice(0, SAME_PIECE_FRONTIER_CONTINUATION_LIMIT)
      if (nextPiece !== undefined) {
        const selectedContinuationOutcome = yield* enumerateWithDeadlineRecovery({
          state: selectedState,
          piece: nextPiece,
          remainingPreparedPieces: continuationTail,
          budget,
          settings,
          geometryKernel,
          nfpIfpService,
          candidateMemoScope,
          control
        })
        if (
          selectedContinuationOutcome === undefined ||
          !selectedContinuationOutcome.fullyEnumerated
        ) {
          break
        }
        selectedContinuation = selectedContinuationOutcome.selected
        for (const alternative of rejectedFrontierAlternatives) {
          attemptedContinuationCount += 1
          const outcome = yield* enumerateWithDeadlineRecovery({
            state: alternative.state,
            piece: nextPiece,
            remainingPreparedPieces: continuationTail,
            budget,
            settings,
            geometryKernel,
            nfpIfpService,
            candidateMemoScope,
            control
          })
          if (outcome === undefined || !outcome.fullyEnumerated) break
          const continuation = outcome.selected
          if (continuation === undefined) continue
          successfulContinuationCount += 1
          const assessment = assessIntrinsicBeamContinuation(continuation, selectedContinuation)
          if (assessment.paretoHeadroom) {
            paretoHeadroomContinuations.push({ alternative, continuation })
          }
          if (assessment.strictImprovement) dominatingContinuationCount += 1
        }
      }
      if (budget.truncationReason !== undefined) break

      const commensurateQueue = yield* calibrateCommensurateQueue({
        state,
        scheduledPiece,
        scheduledOutcome,
        futurePieces,
        nonInertQueueCandidates,
        budget,
        settings,
        geometryKernel,
        nfpIfpService,
        candidateMemoScope,
        control,
        maximumWitnesses
      })
      const classification = classifyIntrinsicQueueBeamHeadroom(
        commensurateQueue.alternateOrderParetoHeadroomCount > 0,
        paretoHeadroomContinuations.length > 0
      )
      steps.push({
        depth,
        scheduledPieceId: preparedPieceId(scheduledPiece),
        scheduled: {
          generatedCandidateCount: scheduledOutcome.generatedCandidateCount,
          scoredCandidateCount: scheduledOutcome.scoredCandidateCount,
          canonicalLegalCandidateCount: scheduledOutcome.canonicalLegalCandidateCount,
          uniqueCanonicalSuccessorCount: scheduledSuccessors.length,
          nondominatedFrontierSize: frontier.length,
          selectedCanonicalGeometryKey: selectedKey,
          selectedOnCanonicalFrontier:
            selectedKey !== undefined &&
            frontier.some(({ canonicalGeometryKey }) => canonicalGeometryKey === selectedKey),
          selectedRanks:
            selectedRanked === undefined
              ? undefined
              : {
                  compactnessRank: selectedRanked.compactnessRank,
                  fragmentationRank: selectedRanked.fragmentationRank,
                  voidRank: selectedRanked.voidRank,
                  frontierRank: selectedRanked.frontierRank
                },
          boundedFrontierWitnesses: boundIntrinsicDiscriminatorWitnesses(
            rankWitnesses(frontier, frontier),
            maximumWitnesses
          )
        },
        queue: {
          ...queueCounters,
          paretoHeadroomCandidateCount: paretoQueueCandidates.length,
          dominatesEveryScheduledSuccessorCount: dominatingQueueCandidates.length,
          bestParetoOpportunity:
            bestQueueOpportunity === undefined ? undefined : candidateWitness(bestQueueOpportunity),
          bestStrictImprovement:
            bestStrictQueueImprovement === undefined
              ? undefined
              : candidateWitness(bestStrictQueueImprovement),
          bestParetoOpportunityRegressesContactStructure:
            bestQueueOpportunity === undefined || scheduledOutcome.selected === undefined
              ? undefined
              : compareFragmentation(bestQueueOpportunity.axes, scheduledOutcome.selected.axes) > 0
        },
        commensurateQueue,
        delayedLineage,
        beam: {
          continuationLimit: SAME_PIECE_FRONTIER_CONTINUATION_LIMIT,
          rejectedFrontierAlternativeCount: rejectedFrontierAlternatives.length,
          attemptedContinuationCount,
          successfulContinuationCount,
          selectedContinuationNoFit: nextPiece !== undefined && selectedContinuation === undefined,
          paretoHeadroomContinuationCount: paretoHeadroomContinuations.length,
          dominatingContinuationCount,
          selectedContinuation:
            selectedContinuation === undefined ? undefined : candidateWitness(selectedContinuation),
          boundedParetoHeadroomWitnesses: paretoHeadroomContinuations
            .slice(0, maximumWitnesses)
            .map(({ alternative, continuation }) => ({
              alternative: candidateWitness(alternative),
              continuation: candidateWitness(continuation),
              contactStructureRegresses:
                selectedContinuation !== undefined &&
                compareFragmentation(continuation.axes, selectedContinuation.axes) > 0
            }))
        },
        classification
      })
      state = selectedState
      if (budget.truncationReason !== undefined) break
    }

    const runtimeMs = Math.max(0, performance.now() - startedAt)
    const status = budget.truncationReason === undefined ? 'completed' : 'truncated'
    return {
      status,
      truncation:
        budget.truncationReason === undefined
          ? undefined
          : { reason: budget.truncationReason, depth: truncationDepth },
      budget: {
        maximumRuntimeMs: budget.maximumRuntimeMs,
        maximumEvaluations: budget.maximumEvaluations,
        evaluations: budget.evaluations,
        runtimeMs
      },
      selectedLineageFinalCanonicalGeometryKey: state.canonicalOccupiedGeometryKey,
      completedDepthCount: steps.length,
      classificationCounts: countClassifications(steps),
      delayedLineage: summarizeDelayedLineage(
        steps,
        input.referenceLineageCanonicalGeometryKeys !== undefined,
        firstMissingReferenceDepth
      ),
      steps
    }
  })
}

interface IntrinsicPartialBeamEntry extends IntrinsicPartialGeometricBeamCandidate {
  readonly state: IrregularBeamState
}

/** Runs the first live Stage 2A beam cell while keeping reordering disabled. */
export function runIntrinsicPartialGeometricBeam(input: {
  readonly orderedPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly finalSheet: SheetSpec
  readonly experimentalWidth: number
  readonly maximumRuntimeMs: number
  readonly maximumEvaluations: number
}): Effect.Effect<
  IntrinsicPartialGeometricBeamResult,
  AuditError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const experimentalWidth = Math.max(0, Math.floor(input.experimentalWidth))
    const protectedControlBudget: AuditBudget = {
      startedAt: performance.now(),
      maximumRuntimeMs: input.maximumRuntimeMs,
      maximumEvaluations: Math.max(1, Math.floor(input.maximumEvaluations)),
      evaluations: 0,
      truncationReason: undefined
    }
    const settings = yield* GeometrySettings
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const candidateMemoScope = new IrregularNfpIfpCandidateMemoScope()
    const protectedControl: IrregularNfpIfpControl = {
      checkpoint: () =>
        performance.now() - protectedControlBudget.startedAt >=
        protectedControlBudget.maximumRuntimeMs
          ? Effect.fail(
              new IrregularNfpIfpControlAbortError({
                reason: 'deadline',
                message: `protected strict control exceeded ${protectedControlBudget.maximumRuntimeMs} ms.`
              })
            )
          : Effect.void
    }
    const initialState = IrregularBeamState.empty(input.orderedPreparedPieces)
    let protectedControlState = initialState
    const protectedControlStates: IrregularBeamState[] = [initialState]
    let experimentalStates: ReadonlyArray<IntrinsicPartialBeamEntry> = []
    const steps: IntrinsicPartialGeometricBeamResult['steps'][number][] = []

    for (let depth = 0; depth < input.orderedPreparedPieces.length; depth += 1) {
      if (auditRuntimeExpired(protectedControlBudget)) break
      const piece = input.orderedPreparedPieces[depth]
      if (piece === undefined) continue
      const remainingPreparedPieces = input.orderedPreparedPieces.slice(depth + 1)
      const outcome = yield* enumerateWithDeadlineRecovery({
        state: protectedControlState,
        piece,
        remainingPreparedPieces,
        budget: protectedControlBudget,
        settings,
        geometryKernel,
        nfpIfpService,
        candidateMemoScope,
        control: protectedControl,
        measureGapContainment: false,
        includeEnvelopeEventCandidates: false
      })
      if (outcome === undefined || !outcome.fullyEnumerated) break
      const selectedCanonicalGeometryKey = outcome.selected?.canonicalGeometryKey
      const protectedSuccessor =
        selectedCanonicalGeometryKey === undefined
          ? undefined
          : outcome.uniqueCanonicalSuccessors.find(
              ({ canonicalGeometryKey }) => canonicalGeometryKey === selectedCanonicalGeometryKey
            )
      if (selectedCanonicalGeometryKey !== undefined && protectedSuccessor === undefined) {
        return yield* Effect.fail(
          new IntrinsicQueueBeamDiscriminatorError({
            operation: 'measurement',
            message:
              'the independently budgeted protected successor was rejected by canonical admission.'
          })
        )
      }
      protectedControlState =
        protectedSuccessor === undefined
          ? protectedControlState.withUnplacedPiece({
              remainingPreparedPieces,
              unplacedPieceId: preparedPieceId(piece)
            })
          : protectedSuccessor.state
      protectedControlStates.push(protectedControlState)
    }
    const protectedControlFinalState = protectedControlState

    const experimentalBudget: AuditBudget = {
      startedAt: performance.now(),
      maximumRuntimeMs: input.maximumRuntimeMs,
      maximumEvaluations: Math.max(1, Math.floor(input.maximumEvaluations)),
      evaluations: 0,
      truncationReason: undefined
    }
    const experimentalControl: IrregularNfpIfpControl = {
      checkpoint: () =>
        performance.now() - experimentalBudget.startedAt >= experimentalBudget.maximumRuntimeMs
          ? Effect.fail(
              new IrregularNfpIfpControlAbortError({
                reason: 'deadline',
                message: `partial geometric beam exceeded ${experimentalBudget.maximumRuntimeMs} ms.`
              })
            )
          : Effect.void
    }

    for (let depth = 0; depth < input.orderedPreparedPieces.length; depth += 1) {
      if (
        protectedControlBudget.truncationReason !== undefined ||
        auditRuntimeExpired(experimentalBudget)
      ) {
        break
      }
      const piece = input.orderedPreparedPieces[depth]
      if (piece === undefined) continue
      const remainingPreparedPieces = input.orderedPreparedPieces.slice(depth + 1)
      const protectedParentState = protectedControlStates[depth]
      const nextProtectedControlState = protectedControlStates[depth + 1]
      if (protectedParentState === undefined || nextProtectedControlState === undefined) break
      const parentStates = deduplicatePartialParents([
        protectedParentState,
        ...experimentalStates.map(({ state }) => state)
      ])
      const successors: AuditCandidate[] = []
      const parentEnumerations: IntrinsicPartialGeometricBeamResult['steps'][number]['parentEnumerations'][number][] = []
      let protectedSuccessor: AuditCandidate | undefined
      const enumerationStartedAt = performance.now()
      for (const parentState of parentStates) {
        const parentStartedAt = performance.now()
        const outcome = yield* enumerateWithDeadlineRecovery({
          state: parentState,
          piece,
          remainingPreparedPieces,
          budget: experimentalBudget,
          settings,
          geometryKernel,
          nfpIfpService,
          candidateMemoScope,
          control: experimentalControl,
          measureGapContainment: false,
          includeEnvelopeEventCandidates: true
        })
        if (outcome === undefined || !outcome.fullyEnumerated) break
        parentEnumerations.push({
          parentFutureEquivalenceDigest: digestSemanticIdentity(
            partialFutureEquivalenceKey(parentState)
          ),
          protectedControl: parentState === protectedParentState,
          generatedCandidateCount: outcome.generatedCandidateCount,
          envelopeEventCandidateCount: outcome.envelopeEventCandidateCount,
          scoredCandidateCount: outcome.scoredCandidateCount,
          canonicalLegalCandidateCount: outcome.canonicalLegalCandidateCount,
          uniqueCanonicalSuccessorCount: outcome.uniqueCanonicalSuccessors.length,
          candidateGenerationRuntimeMs: outcome.candidateGenerationRuntimeMs,
          candidateScoringRuntimeMs: outcome.candidateScoringRuntimeMs,
          canonicalAdmissionRuntimeMs: outcome.canonicalAdmissionRuntimeMs,
          runtimeMs: Math.max(0, performance.now() - parentStartedAt)
        })
        successors.push(...outcome.uniqueCanonicalSuccessors)
        if (parentState === protectedParentState) {
          const protectedControlPlacedPiece =
            nextProtectedControlState.placedCollisionGeometries.length >
            protectedParentState.placedCollisionGeometries.length
          protectedSuccessor = protectedControlPlacedPiece
            ? outcome.uniqueCanonicalSuccessors.find(
                ({ state }) =>
                  partialFutureEquivalenceKey(state) ===
                  partialFutureEquivalenceKey(nextProtectedControlState)
              )
            : undefined
          if (protectedControlPlacedPiece && protectedSuccessor === undefined) {
            return yield* Effect.fail(
              new IntrinsicQueueBeamDiscriminatorError({
                operation: 'measurement',
                message:
                  'the experimental expansion did not preserve the independently computed protected successor.'
              })
            )
          }
        }
      }
      if (experimentalBudget.truncationReason !== undefined) break
      protectedControlState = nextProtectedControlState
      const entries = successors
        .filter(({ state }) => partialStateCanFit(state, input.finalSheet))
        .map(partialBeamEntry)
      const protectedEntry =
        protectedSuccessor === undefined || !partialStateCanFit(protectedSuccessor.state, input.finalSheet)
          ? undefined
          : partialBeamEntry(protectedSuccessor)
      const selectionStartedAt = performance.now()
      const selection = selectIntrinsicPartialGeometricBeam({
        candidates: entries,
        experimentalWidth,
        ...(protectedEntry === undefined ? {} : { protectedControl: protectedEntry })
      })
      const selectionRuntimeMs = Math.max(0, performance.now() - selectionStartedAt)
      experimentalStates = selection.retained
      const canonicalUniqueSuccessorCount = new Set(
        successors.map(({ canonicalGeometryKey }) => canonicalGeometryKey)
      ).size
      const uniqueSuccessorCount = selection.diagnostics.futureDeduplicatedCandidateCount
      steps.push({
        depth,
        scheduledPieceId: preparedPieceId(piece),
        parentCount: parentStates.length,
        parentEnumerations,
        generatedCandidateCount: sumParentEnumerationField(
          parentEnumerations,
          'generatedCandidateCount'
        ),
        envelopeEventCandidateCount: sumParentEnumerationField(
          parentEnumerations,
          'envelopeEventCandidateCount'
        ),
        scoredCandidateCount: sumParentEnumerationField(parentEnumerations, 'scoredCandidateCount'),
        canonicalLegalCandidateCount: sumParentEnumerationField(
          parentEnumerations,
          'canonicalLegalCandidateCount'
        ),
        canonicalUniqueSuccessorCount,
        monotoneFitRejectionCount: successors.length - entries.length,
        uniqueSuccessorCount,
        futureEquivalenceDeduplicationCount:
          entries.length - selection.diagnostics.futureDeduplicatedCandidateCount,
        paretoLayerSizes: selection.diagnostics.paretoLayerSizes,
        paretoLayerExtractionComplete: selection.diagnostics.paretoLayerExtractionComplete,
        unlayeredCandidateCount: selection.diagnostics.unlayeredCandidateCount,
        capacityEvictionCount: Math.max(
          0,
          selection.diagnostics.selectableCandidateCount - selection.retained.length
        ),
        protectedControlDigest:
          protectedEntry === undefined
            ? undefined
            : digestSemanticIdentity(protectedEntry.futureEquivalenceKey),
        protectedControlSurvived: protectedEntry !== undefined,
        futureEquivalenceKeyVersion: PARTIAL_FUTURE_EQUIVALENCE_KEY_VERSION,
        occupiedDispersionVersion: OCCUPIED_DISPERSION_VERSION,
        remainingOrderDigest: preparedOrderDigest(remainingPreparedPieces),
        cumulativeEvaluations:
          protectedControlBudget.evaluations + experimentalBudget.evaluations,
        cumulativeRuntimeMs: Math.max(0, performance.now() - startedAt),
        enumerationRuntimeMs: Math.max(0, selectionStartedAt - enumerationStartedAt),
        candidateGenerationRuntimeMs: sumParentEnumerationField(
          parentEnumerations,
          'candidateGenerationRuntimeMs'
        ),
        candidateScoringRuntimeMs: sumParentEnumerationField(
          parentEnumerations,
          'candidateScoringRuntimeMs'
        ),
        canonicalAdmissionRuntimeMs: sumParentEnumerationField(
          parentEnumerations,
          'canonicalAdmissionRuntimeMs'
        ),
        selectionRuntimeMs,
        selectedSlots: selection.slots.map(traceSelectionSlot)
      })
    }

    const completeEntries = deduplicatePartialEntries([
      ...(partialStateCanFit(protectedControlFinalState, input.finalSheet)
        ? [partialEntryFromState(protectedControlFinalState)]
        : []),
      ...experimentalStates
    ]).filter(
      ({ state }) =>
        state.remainingPreparedPieces.length === 0 && state.unplacedPieceIds.length === 0
    )
    const finalized = yield* Effect.forEach(completeEntries, (entry) =>
      finalizeIntrinsicStrictState(
        input.finalSheet,
        {
          state: entry.state,
          stepTrace: [],
          gapFillEvidence: [],
          runtimeMs: Math.max(0, performance.now() - startedAt)
        },
        Math.max(0, performance.now() - startedAt)
      ).pipe(Effect.map((result) => ({ entry, result })))
    )
    const finalists = finalized.flatMap(({ entry, result }) =>
      result.status !== 'completed' ||
      result.metrics === undefined ||
      result.canonicalGeometryHash === undefined ||
      result.terminalRotationDeg === undefined
        ? []
        : [
            {
              futureEquivalenceKey: entry.futureEquivalenceKey,
              canonicalGeometryKey: entry.canonicalGeometryKey,
              canonicalGeometryHash: result.canonicalGeometryHash,
              terminalRotationDeg: result.terminalRotationDeg,
              metrics: result.metrics,
              placedCollisionGeometries: result.placedCollisionGeometries
            }
          ]
    )
    const rankedMetrics = rankIntrinsicStrictCompletedLayouts(finalists.map(({ metrics }) => metrics))
    const winningHash = rankedMetrics[0]?.canonicalGeometryHash
    const winner = finalists.find(({ metrics }) => metrics.canonicalGeometryHash === winningHash)
    return {
      status:
        protectedControlBudget.truncationReason !== undefined ||
        experimentalBudget.truncationReason !== undefined
          ? 'truncated'
          : winner === undefined
            ? 'incomplete'
            : 'completed',
      experimentalWidth,
      truncationReason:
        protectedControlBudget.truncationReason ?? experimentalBudget.truncationReason,
      evaluations: protectedControlBudget.evaluations + experimentalBudget.evaluations,
      protectedControlEvaluations: protectedControlBudget.evaluations,
      experimentalEvaluations: experimentalBudget.evaluations,
      runtimeMs: Math.max(0, performance.now() - startedAt),
      completedDepthCount: steps.length,
      steps,
      finalists,
      winner
    }
  })
}

function deduplicatePartialParents(
  states: ReadonlyArray<IrregularBeamState>
): ReadonlyArray<IrregularBeamState> {
  const unique = new Map<string, IrregularBeamState>()
  for (const state of states) {
    const key = partialFutureEquivalenceKey(state)
    if (!unique.has(key)) unique.set(key, state)
  }
  return [...unique.values()].toSorted((first, second) =>
    partialFutureEquivalenceKey(first).localeCompare(partialFutureEquivalenceKey(second))
  )
}

function deduplicatePartialEntries(
  entries: ReadonlyArray<IntrinsicPartialBeamEntry>
): ReadonlyArray<IntrinsicPartialBeamEntry> {
  const unique = new Map<string, IntrinsicPartialBeamEntry>()
  for (const entry of entries) {
    if (!unique.has(entry.futureEquivalenceKey)) unique.set(entry.futureEquivalenceKey, entry)
  }
  return [...unique.values()]
}

function partialBeamEntry(candidate: AuditCandidate): IntrinsicPartialBeamEntry {
  return {
    state: candidate.state,
    parentFutureEquivalenceKey: candidate.parentFutureEquivalenceKey,
    futureEquivalenceKey: partialFutureEquivalenceKey(candidate.state),
    canonicalGeometryKey: candidate.canonicalGeometryKey,
    axes: candidate.axes,
    placedCollisionGeometries: candidate.state.placedCollisionGeometries
  }
}

function partialEntryFromState(state: IrregularBeamState): IntrinsicPartialBeamEntry {
  const axes = measureIntrinsicQueueBeamAxes(state)
  if (axes === undefined) {
    throw new Error('a non-empty exact partial state must have finite geometric beam axes')
  }
  return {
    state,
    parentFutureEquivalenceKey: partialFutureEquivalenceKey(state),
    futureEquivalenceKey: partialFutureEquivalenceKey(state),
    canonicalGeometryKey: state.canonicalOccupiedGeometryKey,
    axes,
    placedCollisionGeometries: state.placedCollisionGeometries
  }
}

function partialFutureEquivalenceKey(state: IrregularBeamState): string {
  return JSON.stringify({
    version: PARTIAL_FUTURE_EQUIVALENCE_KEY_VERSION,
    occupied: state.canonicalOccupiedGeometryKey,
    remaining: state.remainingPreparedPieces.map(intrinsicPreparedPieceClassKey),
    unplaced: [...state.unplacedPieceIds].toSorted()
  })
}

function preparedOrderDigest(pieces: ReadonlyArray<IrregularPreparedPiece>): string {
  return createHash('sha256')
    .update(pieces.map(intrinsicPreparedPieceClassKey).join('\u0000'))
    .digest('hex')
}

function digestSemanticIdentity(identity: string): string {
  return createHash('sha256').update(identity).digest('hex')
}

function traceSelectionSlot(
  slot: IntrinsicPartialGeometricBeamSelection<IntrinsicPartialBeamEntry>['slots'][number]
): IntrinsicPartialGeometricBeamTraceSlot {
  const dispersion = slot.dispersion
  return {
    role: slot.role,
    layer: slot.layer,
    visit: slot.visit,
    futureEquivalenceDigest: digestSemanticIdentity(slot.futureEquivalenceKey),
    parentFutureEquivalenceDigest:
      slot.parentFutureEquivalenceKey === undefined
        ? undefined
        : digestSemanticIdentity(slot.parentFutureEquivalenceKey),
    canonicalGeometryHash: digestSemanticIdentity(slot.canonicalGeometryKey),
    axes: slot.axes,
    dispersion:
      dispersion === undefined
        ? undefined
        : {
            voidHamming: dispersion.voidHamming,
            contactHamming: dispersion.contactHamming,
            symmetricDifferenceNumerator: dispersion.symmetricDifferenceNumerator,
            pairUnionDenominator: dispersion.pairUnionDenominator,
            symmetricDifferenceRatio: dispersion.symmetricDifferenceRatio,
            nearestRetainedFutureEquivalenceDigest: digestSemanticIdentity(
              dispersion.nearestRetainedFutureEquivalenceKey
            )
          }
  }
}

function sumParentEnumerationField(
  entries: IntrinsicPartialGeometricBeamResult['steps'][number]['parentEnumerations'],
  field:
    | 'generatedCandidateCount'
    | 'envelopeEventCandidateCount'
    | 'scoredCandidateCount'
    | 'canonicalLegalCandidateCount'
    | 'candidateGenerationRuntimeMs'
    | 'candidateScoringRuntimeMs'
    | 'canonicalAdmissionRuntimeMs'
): number {
  return entries.reduce((sum, entry) => sum + entry[field], 0)
}

function partialStateCanFit(state: IrregularBeamState, sheet: SheetSpec): boolean {
  const bounds = state.translatedCollisionBounds
  if (bounds === undefined) return true
  const width = bounds.width
  const height = bounds.height
  return (
    (width <= sheet.width && height <= sheet.height) ||
    (height <= sheet.width && width <= sheet.height)
  )
}

interface CommensurateQueueCalibrationInput {
  readonly state: IrregularBeamState
  readonly scheduledPiece: IrregularPreparedPiece
  readonly scheduledOutcome: EnumeratedSuccessors
  readonly futurePieces: ReadonlyArray<IrregularPreparedPiece>
  readonly nonInertQueueCandidates: ReadonlyArray<AuditCandidate>
  readonly budget: AuditBudget
  readonly settings: IrregularNestingSettings
  readonly geometryKernel: GeometryKernel.Service
  readonly nfpIfpService: NfpIfpServiceShape
  readonly candidateMemoScope: IrregularNfpIfpCandidateMemoScope
  readonly control: IrregularNfpIfpControl
  readonly maximumWitnesses: number
}

function calibrateCommensurateQueue(
  input: CommensurateQueueCalibrationInput
): Effect.Effect<
  IntrinsicCommensurateQueueReport,
  AuditError,
  never
> {
  return Effect.gen(function* () {
    const scheduledGeometryClass = intrinsicPreparedPieceClassKey(input.scheduledPiece)
    const classRepresentatives = distinctGeometryClassRepresentatives(input.futurePieces).filter(
      (piece) => intrinsicPreparedPieceClassKey(piece) !== scheduledGeometryClass
    )
    if (classRepresentatives.length === 0) {
      return emptyCommensurateQueueReport('no-alternate-class')
    }
    const alternatePieceIds = new Set(classRepresentatives.map(preparedPieceId))
    const proposedCandidate = orderCandidates(
      input.nonInertQueueCandidates.filter(({ pieceId }) => alternatePieceIds.has(pieceId))
    )[0]
    if (proposedCandidate === undefined) {
      return emptyCommensurateQueueReport('no-non-inert-alternate')
    }
    const alternatePiece = input.futurePieces.find(
      (piece) => preparedPieceId(piece) === proposedCandidate.pieceId
    )
    if (alternatePiece === undefined) {
      return emptyCommensurateQueueReport('no-non-inert-alternate')
    }
    const alternatePieceId = preparedPieceId(alternatePiece)
    const alternateGeometryClass = intrinsicPreparedPieceClassKey(alternatePiece)
    const alternateIndex = input.futurePieces.findIndex(
      (piece) => preparedPieceId(piece) === alternatePieceId
    )
    const tailWithoutAlternate = input.futurePieces.filter((_, index) => index !== alternateIndex)

    const scheduledFirst = input.scheduledOutcome
    const alternateFirst = yield* enumerateWithDeadlineRecovery({
      state: input.state,
      piece: alternatePiece,
      remainingPreparedPieces: [input.scheduledPiece, ...tailWithoutAlternate],
      budget: input.budget,
      settings: input.settings,
      geometryKernel: input.geometryKernel,
      nfpIfpService: input.nfpIfpService,
      candidateMemoScope: input.candidateMemoScope,
      control: input.control
    })
    if (
      alternateFirst === undefined ||
      !alternateFirst.fullyEnumerated
    ) {
      return {
        ...emptyCommensurateQueueReport('incomplete'),
        alternatePieceId,
        alternateGeometryClass,
        scheduledThenAlternate: emptyCommensurateOrderReport(
          scheduledFirst.uniqueCanonicalSuccessors.length
        ),
        alternateThenScheduled: emptyCommensurateOrderReport(
          alternateFirst?.uniqueCanonicalSuccessors.length ?? 0
        )
      }
    }

    const scheduledThenAlternate = yield* completeCommensurateOrder({
      firstStepCandidates: orderCandidates(scheduledFirst.uniqueCanonicalSuccessors).slice(
        0,
        COMMENSURATE_FIRST_STEP_LIMIT
      ),
      firstStepCanonicalSuccessorCount: scheduledFirst.uniqueCanonicalSuccessors.length,
      secondPiece: alternatePiece,
      remainingPreparedPieces: tailWithoutAlternate,
      ...sharedCommensurateEnumerationInput(input)
    })
    const alternateThenScheduled = yield* completeCommensurateOrder({
      firstStepCandidates: orderCandidates(alternateFirst.uniqueCanonicalSuccessors).slice(
        0,
        COMMENSURATE_FIRST_STEP_LIMIT
      ),
      firstStepCanonicalSuccessorCount: alternateFirst.uniqueCanonicalSuccessors.length,
      secondPiece: input.scheduledPiece,
      remainingPreparedPieces: tailWithoutAlternate,
      ...sharedCommensurateEnumerationInput(input)
    })
    if (scheduledThenAlternate === undefined || alternateThenScheduled === undefined) {
      return {
        ...emptyCommensurateQueueReport('incomplete'),
        alternatePieceId,
        alternateGeometryClass,
        scheduledThenAlternate:
          scheduledThenAlternate?.report ??
          emptyCommensurateOrderReport(scheduledFirst.uniqueCanonicalSuccessors.length),
        alternateThenScheduled:
          alternateThenScheduled?.report ??
          emptyCommensurateOrderReport(alternateFirst.uniqueCanonicalSuccessors.length)
      }
    }

    const scheduledKeys = new Set(
      scheduledThenAlternate.completed.map(({ canonicalGeometryKey }) => canonicalGeometryKey)
    )
    const alternateAssessments = alternateThenScheduled.completed.map((candidate) => ({
      candidate,
      assessment: assessIntrinsicQueueCandidate(candidate, scheduledThenAlternate.completed)
    }))
    const pareto = alternateAssessments.filter(({ assessment }) => assessment.paretoHeadroom)
    const strict = alternateAssessments.filter(({ assessment }) => assessment.strictImprovement)
    const bestAlternate = orderCandidates(pareto.map(({ candidate }) => candidate))[0]
    return {
      status: 'completed',
      alternatePieceId,
      alternateGeometryClass,
      scheduledThenAlternate: scheduledThenAlternate.report,
      alternateThenScheduled: alternateThenScheduled.report,
      convergedCanonicalSuccessorCount: alternateThenScheduled.completed.filter(
        ({ canonicalGeometryKey }) => scheduledKeys.has(canonicalGeometryKey)
      ).length,
      alternateOrderParetoHeadroomCount: pareto.length,
      alternateOrderStrictImprovementCount: strict.length,
      bestAlternateOrderWitness:
        bestAlternate === undefined ? undefined : candidateWitness(bestAlternate)
    }
  })
}

interface CommensurateOrderInput {
  readonly firstStepCandidates: ReadonlyArray<AuditCandidate>
  readonly firstStepCanonicalSuccessorCount: number
  readonly secondPiece: IrregularPreparedPiece
  readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly budget: AuditBudget
  readonly settings: IrregularNestingSettings
  readonly geometryKernel: GeometryKernel.Service
  readonly nfpIfpService: NfpIfpServiceShape
  readonly candidateMemoScope: IrregularNfpIfpCandidateMemoScope
  readonly control: IrregularNfpIfpControl
  readonly maximumWitnesses: number
}

function completeCommensurateOrder(input: CommensurateOrderInput): Effect.Effect<
  | {
      readonly completed: ReadonlyArray<AuditCandidate>
      readonly report: IntrinsicCommensurateQueueOrderReport
    }
  | undefined,
  AuditError,
  never
> {
  return Effect.gen(function* () {
    const completedByKey = new Map<string, AuditCandidate>()
    for (const firstStep of input.firstStepCandidates) {
      const outcome = yield* enumerateWithDeadlineRecovery({
        state: firstStep.state,
        piece: input.secondPiece,
        remainingPreparedPieces: input.remainingPreparedPieces,
        budget: input.budget,
        settings: input.settings,
        geometryKernel: input.geometryKernel,
        nfpIfpService: input.nfpIfpService,
        candidateMemoScope: input.candidateMemoScope,
        control: input.control
      })
      if (outcome === undefined || !outcome.fullyEnumerated) return undefined
      for (const candidate of orderCandidates(outcome.uniqueCanonicalSuccessors).slice(
        0,
        COMMENSURATE_SECOND_STEP_LIMIT
      )) {
        const incumbent = completedByKey.get(candidate.canonicalGeometryKey)
        if (incumbent === undefined || compareCandidateIdentity(candidate, incumbent) < 0) {
          completedByKey.set(candidate.canonicalGeometryKey, candidate)
        }
      }
    }
    const completed = orderCandidates([...completedByKey.values()])
    return {
      completed,
      report: {
        firstStepCanonicalSuccessorCount: input.firstStepCanonicalSuccessorCount,
        retainedFirstStepCount: input.firstStepCandidates.length,
        completedSuccessorCount: completed.length,
        boundedCompletedWitnesses: completed.slice(0, input.maximumWitnesses).map(candidateWitness)
      }
    }
  })
}

function sharedCommensurateEnumerationInput(input: CommensurateQueueCalibrationInput) {
  return {
    budget: input.budget,
    settings: input.settings,
    geometryKernel: input.geometryKernel,
    nfpIfpService: input.nfpIfpService,
    candidateMemoScope: input.candidateMemoScope,
    control: input.control,
    maximumWitnesses: input.maximumWitnesses
  }
}

function emptyCommensurateOrderReport(
  firstStepCanonicalSuccessorCount = 0
): IntrinsicCommensurateQueueOrderReport {
  return {
    firstStepCanonicalSuccessorCount,
    retainedFirstStepCount: 0,
    completedSuccessorCount: 0,
    boundedCompletedWitnesses: []
  }
}

function emptyCommensurateQueueReport(
  status: IntrinsicCommensurateQueueReport['status']
): IntrinsicCommensurateQueueReport {
  return {
    status,
    alternatePieceId: undefined,
    alternateGeometryClass: undefined,
    scheduledThenAlternate: emptyCommensurateOrderReport(),
    alternateThenScheduled: emptyCommensurateOrderReport(),
    convergedCanonicalSuccessorCount: 0,
    alternateOrderParetoHeadroomCount: 0,
    alternateOrderStrictImprovementCount: 0,
    bestAlternateOrderWitness: undefined
  }
}

function enumerateWithDeadlineRecovery(
  input: EnumerationInput
): Effect.Effect<
  EnumeratedSuccessors | undefined,
  AuditError,
  never
> {
  return enumerateSuccessors(input).pipe(
    Effect.catchTag('IrregularNfpIfpControlAbortError', () => {
      input.budget.truncationReason = 'maximum-runtime'
      return Effect.succeed(undefined)
    })
  )
}

interface EnumerationInput {
  readonly state: IrregularBeamState
  readonly piece: IrregularPreparedPiece
  readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly budget: AuditBudget
  readonly settings: IrregularNestingSettings
  readonly geometryKernel: GeometryKernel.Service
  readonly nfpIfpService: NfpIfpServiceShape
  readonly candidateMemoScope: IrregularNfpIfpCandidateMemoScope
  readonly control: IrregularNfpIfpControl
  readonly measureGapContainment?: boolean
  readonly includeEnvelopeEventCandidates?: boolean
}

function enumerateSuccessors(
  input: EnumerationInput
): Effect.Effect<
  EnumeratedSuccessors,
  | IntrinsicQueueBeamDiscriminatorError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError
> {
  return Effect.gen(function* () {
    let generatedCandidateCount = 0
    let envelopeEventCandidateCount = 0
    let scoredCandidateCount = 0
    let canonicalLegalCandidateCount = 0
    let candidateGenerationRuntimeMs = 0
    let candidateScoringRuntimeMs = 0
    let canonicalAdmissionRuntimeMs = 0
    const familyWinners = new Map<string, UnmeasuredAuditCandidate>()
    const uniqueCanonicalSuccessors = new Map<string, UnmeasuredAuditCandidate>()
    const gapRegions =
      input.measureGapContainment === false
        ? undefined
        : deriveCanonicalIntrinsicGapRegions(input.state.placedCollisionGeometries)
    for (const transform of [...input.piece.transforms].sort(transformCandidateOrder)) {
      const candidateGenerationStartedAt = performance.now()
      yield* input.control.checkpoint('candidate-points')
      const moving = yield* input.geometryKernel.transformCollisionGeometry({
        geometry: input.piece.collisionGeometry,
        transform
      })
      const movingCollisionAreaMm2 = canonicalCollisionAreaMm2(moving)
      if (movingCollisionAreaMm2 === undefined) continue
      const ordinaryCandidates =
        input.state.placedCollisionGeometries.length === 0
          ? originAnchorCandidates(moving)
          : yield* input.nfpIfpService.generatePlacementCandidates({
              sheet: INTRINSIC_COORDINATE_DOMAIN,
              placed: input.state.placedCollisionGeometries,
              placedCollisionIndex: input.state.placedCollisionIndex,
              moving,
              settings: input.settings,
              candidateDomain: 'sheetless-nfp',
              candidateMemoScope: input.candidateMemoScope,
              control: input.control
            })
      const envelopeEventCandidates = input.includeEnvelopeEventCandidates
        ? yield* generateIntrinsicEnvelopeEventCandidates({
            state: input.state,
            moving,
            settings: input.settings,
            nfpIfpService: input.nfpIfpService,
            control: input.control
          })
        : []
      const ordinaryKeys = new Set(ordinaryCandidates.map(candidateGridIdentity))
      const addedEnvelopeCandidates = envelopeEventCandidates.filter(
        (candidate) => !ordinaryKeys.has(candidateGridIdentity(candidate))
      )
      const candidates = [
        ...ordinaryCandidates.map((candidate) => ({ candidate, protectedEligible: true })),
        ...addedEnvelopeCandidates.map((candidate) => ({
          candidate,
          protectedEligible: false
        }))
      ]
      candidateGenerationRuntimeMs += Math.max(
        0,
        performance.now() - candidateGenerationStartedAt
      )
      generatedCandidateCount += candidates.length
      envelopeEventCandidateCount += addedEnvelopeCandidates.length
      for (const { candidate, protectedEligible } of candidates) {
        if (!takeAuditEvaluation(input.budget)) {
          const finalized = measureEnumeratedAuditCandidates({
            familyWinners,
            uniqueCanonicalSuccessors
          })
          if (finalized.measurementFailureCanonicalGeometryKeys.length > 0) {
            return yield* Effect.fail(
              new IntrinsicQueueBeamDiscriminatorError({
                operation: 'measurement',
                message: `exact-legal canonical successors failed topology measurement: ${finalized.measurementFailureCanonicalGeometryKeys.join(', ')}`
              })
            )
          }
          candidateScoringRuntimeMs += finalized.runtimeMs
          canonicalAdmissionRuntimeMs += finalized.canonicalAdmissionRuntimeMs
          return {
            generatedCandidateCount,
            envelopeEventCandidateCount,
            scoredCandidateCount,
            canonicalLegalCandidateCount: finalized.canonicalLegalCandidateCount,
            candidateGenerationRuntimeMs,
            candidateScoringRuntimeMs,
            canonicalAdmissionRuntimeMs,
            uniqueCanonicalSuccessors: finalized.uniqueCanonicalSuccessors,
            selected: finalized.selected,
            fullyEnumerated: false
          }
        }
        const candidateScoringStartedAt = performance.now()
        const scored = constructUnmeasuredAuditCandidate({
          ...input,
          moving,
          candidate,
          gapRegions
        })
        candidateScoringRuntimeMs += Math.max(0, performance.now() - candidateScoringStartedAt)
        if (scored === undefined) continue
        scoredCandidateCount += 1
        const familyWinner = familyWinners.get(scored.transformFamily)
        if (
          protectedEligible &&
          (familyWinner === undefined || compareLocalScore(scored.score, familyWinner.score) < 0)
        ) {
          familyWinners.set(scored.transformFamily, scored)
        }
        const incumbent = uniqueCanonicalSuccessors.get(scored.canonicalGeometryKey)
        if (incumbent === undefined || compareCandidateIdentity(scored, incumbent) < 0) {
          uniqueCanonicalSuccessors.set(scored.canonicalGeometryKey, scored)
        }
      }
    }
    const finalized = measureEnumeratedAuditCandidates({
      familyWinners,
      uniqueCanonicalSuccessors
    })
    if (finalized.measurementFailureCanonicalGeometryKeys.length > 0) {
      return yield* Effect.fail(
        new IntrinsicQueueBeamDiscriminatorError({
          operation: 'measurement',
          message: `exact-legal canonical successors failed topology measurement: ${finalized.measurementFailureCanonicalGeometryKeys.join(', ')}`
        })
      )
    }
    candidateScoringRuntimeMs += finalized.runtimeMs
    canonicalAdmissionRuntimeMs += finalized.canonicalAdmissionRuntimeMs
    canonicalLegalCandidateCount = finalized.canonicalLegalCandidateCount
    return {
      generatedCandidateCount,
      envelopeEventCandidateCount,
      scoredCandidateCount,
      canonicalLegalCandidateCount,
      candidateGenerationRuntimeMs,
      candidateScoringRuntimeMs,
      canonicalAdmissionRuntimeMs,
      uniqueCanonicalSuccessors: finalized.uniqueCanonicalSuccessors,
      selected: finalized.selected,
      fullyEnumerated: true
    }
  })
}

/**
 * Adds sheet-independent contact points where an axis-aligned NFP segment
 * crosses an occupied-envelope alignment event. Ordinary NFP vertices remain
 * the protected control; these bounded interior points are experimental
 * successors only.
 */
export function generateIntrinsicEnvelopeEventCandidates(input: {
  readonly state: IrregularBeamState
  readonly moving: TransformedCollisionGeometry
  readonly settings: IrregularNestingSettings
  readonly nfpIfpService: NfpIfpServiceShape
  readonly control?: IrregularNfpIfpControl
}): Effect.Effect<
  ReadonlyArray<IrregularPlacementCandidate>,
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError
> {
  return Effect.gen(function* () {
    const occupied = input.state.translatedCollisionBounds
    if (occupied === undefined || input.state.placedCollisionGeometries.length === 0) return []

    const occupiedMinX = toGridMm(occupied.minX)
    const occupiedMaxX = toGridMm(occupied.maxX)
    const occupiedMinY = toGridMm(occupied.minY)
    const occupiedMaxY = toGridMm(occupied.maxY)
    const movingMinX = toGridMm(input.moving.bounds.minX)
    const movingMaxX = toGridMm(input.moving.bounds.maxX)
    const movingMinY = toGridMm(input.moving.bounds.minY)
    const movingMaxY = toGridMm(input.moving.bounds.maxY)
    if (
      occupiedMinX === undefined ||
      occupiedMaxX === undefined ||
      occupiedMinY === undefined ||
      occupiedMaxY === undefined ||
      movingMinX === undefined ||
      movingMaxX === undefined ||
      movingMinY === undefined ||
      movingMaxY === undefined
    ) {
      return []
    }

    const xEvents = new Set([
      occupiedMinX - movingMinX,
      occupiedMinX - movingMaxX,
      occupiedMaxX - movingMinX,
      occupiedMaxX - movingMaxX
    ])
    const yEvents = new Set([
      occupiedMinY - movingMinY,
      occupiedMinY - movingMaxY,
      occupiedMaxY - movingMinY,
      occupiedMaxY - movingMaxY
    ])
    const candidatePoints = new Map<string, { readonly x: number; readonly y: number }>()
    const addPoint = (x: number, y: number) => {
      candidatePoints.set(`${x},${y}`, { x, y })
    }

    for (const fixed of input.state.placedCollisionGeometries) {
      yield* input.control?.checkpoint('candidate-points') ?? Effect.void
      const nfp = yield* input.nfpIfpService.computeNfp({
        fixed,
        moving: input.moving,
        settings: input.settings.geometry
      })
      const boundary = nfp.boundary.points.flatMap((point) => {
        const x = toGridMm(point.x)
        const y = toGridMm(point.y)
        return x === undefined || y === undefined ? [] : [{ x, y }]
      })
      for (let index = 0; index < boundary.length; index += 1) {
        const start = boundary[index]
        const end = boundary[(index + 1) % boundary.length]
        if (start === undefined || end === undefined) continue
        if (start.y === end.y) {
          const minimumX = Math.min(start.x, end.x)
          const maximumX = Math.max(start.x, end.x)
          for (const x of xEvents) {
            if (x >= minimumX && x <= maximumX) addPoint(x, start.y)
          }
        }
        if (start.x === end.x) {
          const minimumY = Math.min(start.y, end.y)
          const maximumY = Math.max(start.y, end.y)
          for (const y of yEvents) {
            if (y >= minimumY && y <= maximumY) addPoint(start.x, y)
          }
        }
      }
    }

    const candidates: IrregularPlacementCandidate[] = []
    for (const point of [...candidatePoints.values()].toSorted(
      (first, second) => first.y - second.y || first.x - second.x
    )) {
      yield* input.control?.checkpoint('candidate-points') ?? Effect.void
      const candidate = new IrregularPlacementCandidate({
        pieceId: input.moving.sourcePieceId,
        transform: input.moving.transform,
        point: { x: fromGrid(point.x), y: fromGrid(point.y) },
        diagnostics: []
      })
      const legal = yield* PlacementValidation.checkSheetless({
        placed: input.state.placedCollisionGeometries,
        placedCollisionIndex: input.state.placedCollisionIndex,
        moving: input.moving,
        candidate
      })
      if (legal) candidates.push(candidate)
    }
    return candidates
  })
}

function scoreAuditCandidate(
  input: EnumerationInput & {
    readonly moving: TransformedCollisionGeometry
    readonly candidate: IrregularPlacementCandidate
    readonly gapRegions: ReadonlyArray<CanonicalIntrinsicGapRegion> | undefined
  }
): AuditCandidate | undefined {
  const candidate = constructUnmeasuredAuditCandidate(input)
  return candidate === undefined ? undefined : measureAuditCandidate(candidate)
}

function constructUnmeasuredAuditCandidate(
  input: EnumerationInput & {
    readonly moving: TransformedCollisionGeometry
    readonly candidate: IrregularPlacementCandidate
    readonly gapRegions: ReadonlyArray<CanonicalIntrinsicGapRegion> | undefined
  }
): UnmeasuredAuditCandidate | undefined {
  const placement = makePlacement(input.piece, input.candidate)
  const placed = new IrregularPlacedPiece({ placement, collisionGeometry: input.moving })
  const state = input.state
    .withPlacement({
      remainingPreparedPieces: input.remainingPreparedPieces,
      placedCollisionGeometry: placed,
      placementOrderPieceId: preparedPieceId(input.piece)
    })
    .withBottomLeftAnchored()
  if (state === undefined) return undefined
  const envelope = measureIntrinsicStrictCanonicalEnvelope(state.placedCollisionGeometries)
  const sharedBoundaryLengthMm = state.sharedCollisionBoundaryLengthMm
  const gridX = toGridMm(input.candidate.point.x)
  const gridY = toGridMm(input.candidate.point.y)
  if (
    envelope === undefined ||
    sharedBoundaryLengthMm === undefined ||
    gridX === undefined ||
    gridY === undefined
  ) {
    return undefined
  }
  const containingGap = input.gapRegions
    ?.filter((region) =>
      candidateContainedInIntrinsicGap(input.moving, input.candidate.point, region)
    )
    .toSorted(
      (first, second) =>
        first.areaMm2 - second.areaMm2 || first.canonicalKey.localeCompare(second.canonicalKey)
    )[0]
  return {
    state,
    parentFutureEquivalenceKey: partialFutureEquivalenceKey(input.state),
    pieceId: preparedPieceId(input.piece),
    transformFamily: transformFamilyKey(input.candidate.transform),
    gridPoint: { x: gridX, y: gridY },
    canonicalGeometryKey: state.canonicalOccupiedGeometryKey,
    containingGap,
    movingCollisionAreaMm2: canonicalCollisionAreaMm2(input.moving) ?? 0,
    score: {
      maximumSideMm: envelope.maximumSideMm,
      envelopeAreaMm2: envelope.envelopeAreaMm2,
      envelopeSpanMm: envelope.envelopeSpanMm,
      sharedBoundaryLengthMm,
      canonicalCombinedGeometryKey: state.canonicalOccupiedGeometryKey
    }
  }
}

function measureAuditCandidate(
  candidate: UnmeasuredAuditCandidate
): AuditCandidate | undefined {
  const axes = measureIntrinsicQueueBeamAxes(candidate.state)
  return axes === undefined ? undefined : { ...candidate, axes }
}

function measureEnumeratedAuditCandidates(input: {
  readonly familyWinners: ReadonlyMap<string, UnmeasuredAuditCandidate>
  readonly uniqueCanonicalSuccessors: ReadonlyMap<string, UnmeasuredAuditCandidate>
}): {
  readonly uniqueCanonicalSuccessors: ReadonlyArray<AuditCandidate>
  readonly selected: AuditCandidate | undefined
  readonly runtimeMs: number
  readonly canonicalAdmissionRuntimeMs: number
  readonly canonicalLegalCandidateCount: number
  readonly measurementFailureCanonicalGeometryKeys: ReadonlyArray<string>
} {
  const startedAt = performance.now()
  let canonicalAdmissionRuntimeMs = 0
  let canonicalLegalCandidateCount = 0
  const measurementFailureCanonicalGeometryKeys: string[] = []
  const uniqueCanonicalSuccessors = [...input.uniqueCanonicalSuccessors.values()].flatMap(
    (candidate) => {
      const admissionStartedAt = performance.now()
      const canonicalLegal = isCanonicalSheetlessStateLegal(candidate.state)
      canonicalAdmissionRuntimeMs += Math.max(0, performance.now() - admissionStartedAt)
      if (!canonicalLegal) return []
      canonicalLegalCandidateCount += 1
      const measured = measureAuditCandidate(candidate)
      if (measured === undefined) {
        measurementFailureCanonicalGeometryKeys.push(candidate.canonicalGeometryKey)
      }
      return measured === undefined ? [] : [measured]
    }
  )
  const selectedUnmeasured = selectIntrinsicStrictFamilyWinner(
    [...input.familyWinners.values()],
    'pure-growth'
  )
  const selected =
    selectedUnmeasured === undefined ? undefined : measureAuditCandidate(selectedUnmeasured)
  return {
    uniqueCanonicalSuccessors,
    selected,
    runtimeMs: Math.max(
      0,
      performance.now() - startedAt - canonicalAdmissionRuntimeMs
    ),
    canonicalAdmissionRuntimeMs,
    canonicalLegalCandidateCount,
    measurementFailureCanonicalGeometryKeys
  }
}

/** Audits one exact historical successor without changing search selection. */
export function auditIntrinsicReferenceSuccessorReachability(input: {
  readonly parentState: IrregularBeamState
  readonly expectedState: IrregularBeamState
  readonly piece: IrregularPreparedPiece
  readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
}): Effect.Effect<
  IntrinsicReferenceSuccessorReachabilityAudit,
  AuditError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const settings = yield* GeometrySettings
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const pieceId = preparedPieceId(input.piece)
    const expectedPlaced = input.expectedState.placedCollisionGeometries.find(
      (placed) => placedPieceId(placed) === pieceId
    )
    if (expectedPlaced === undefined) {
      return yield* Effect.fail(
        new IntrinsicQueueBeamDiscriminatorError({
          operation: 'input',
          message: `expected successor does not contain scheduled piece ${pieceId}.`
        })
      )
    }
    const transform = input.piece.transforms.find(
      (candidate) =>
        candidate.mirrored === expectedPlaced.placement.transform.mirrored &&
        circularDegreeDistance(
          candidate.rotationDeg,
          expectedPlaced.placement.transform.rotationDeg
        ) <= 0.01
    )
    if (transform === undefined) {
      return yield* Effect.fail(
        new IntrinsicQueueBeamDiscriminatorError({
          operation: 'input',
          message: `expected successor transform is unavailable for ${pieceId}.`
        })
      )
    }
    const parentAlignment = referenceParentAlignment(input.parentState, input.expectedState)
    if (parentAlignment === undefined) {
      return yield* Effect.fail(
        new IntrinsicQueueBeamDiscriminatorError({
          operation: 'input',
          message: 'expected successor does not preserve the parent as one rigid translation.'
        })
      )
    }
    const targetGridX = toGridMm(
      expectedPlaced.placement.transform.translateX - parentAlignment.x
    )
    const targetGridY = toGridMm(
      expectedPlaced.placement.transform.translateY - parentAlignment.y
    )
    const alignmentGridX = toGridMm(parentAlignment.x)
    const alignmentGridY = toGridMm(parentAlignment.y)
    if (
      targetGridX === undefined ||
      targetGridY === undefined ||
      alignmentGridX === undefined ||
      alignmentGridY === undefined
    ) {
      return yield* Effect.fail(
        new IntrinsicQueueBeamDiscriminatorError({
          operation: 'input',
          message: 'expected successor translation is outside the canonical collision grid.'
        })
      )
    }
    const moving = yield* geometryKernel.transformCollisionGeometry({
      geometry: input.piece.collisionGeometry,
      transform
    })
    const targetCandidate = new IrregularPlacementCandidate({
      pieceId: moving.sourcePieceId,
      transform,
      point: { x: fromGrid(targetGridX), y: fromGrid(targetGridY) },
      diagnostics: []
    })
    const directLegal = yield* PlacementValidation.checkSheetless({
      placed: input.parentState.placedCollisionGeometries,
      placedCollisionIndex: input.parentState.placedCollisionIndex,
      moving,
      candidate: targetCandidate
    })
    let matchingVertexCount = 0
    let matchingSegmentCount = 0
    const matchingSegments: Array<{
      readonly start: { readonly x: number; readonly y: number }
      readonly end: { readonly x: number; readonly y: number }
    }> = []
    for (const fixed of input.parentState.placedCollisionGeometries) {
      const nfp = yield* nfpIfpService.computeNfp({
        fixed,
        moving,
        settings: settings.geometry
      })
      const path = nfp.boundary.points.flatMap((point) => {
        const x = toGridMm(point.x)
        const y = toGridMm(point.y)
        return x === undefined || y === undefined ? [] : [{ x, y }]
      })
      matchingVertexCount += path.filter(
        (point) => point.x === targetGridX && point.y === targetGridY
      ).length
      for (let index = 0; index < path.length; index += 1) {
        const start = path[index]
        const end = path[(index + 1) % path.length]
        if (
          start !== undefined &&
          end !== undefined &&
          gridPointOnSegment({ x: targetGridX, y: targetGridY }, start, end)
        ) {
          matchingSegmentCount += 1
          matchingSegments.push({ start, end })
        }
      }
    }
    const envelopeAlignmentEvents = referenceEnvelopeAlignmentEvents({
      parentState: input.parentState,
      moving,
      targetGridX,
      targetGridY
    })

    const runFreshGeneration = () =>
      Effect.gen(function* () {
        let provenance: NfpIfpCandidateProvenance | undefined
        const candidates = yield* nfpIfpService.generatePlacementCandidates({
          sheet: INTRINSIC_COORDINATE_DOMAIN,
          placed: input.parentState.placedCollisionGeometries,
          placedCollisionIndex: input.parentState.placedCollisionIndex,
          moving,
          settings,
          candidateDomain: 'sheetless-nfp',
          candidateMemoScope: new IrregularNfpIfpCandidateMemoScope(),
          onCandidateProvenance: (snapshot) => {
            provenance = snapshot
          }
        })
        return { candidates, provenance }
      })
    const firstRun = yield* runFreshGeneration()
    const secondRun = yield* runFreshGeneration()
    const generatedKeys = (candidates: ReadonlyArray<IrregularPlacementCandidate>) =>
      candidates.map(candidateGridIdentity).toSorted()
    const firstKeys = generatedKeys(firstRun.candidates)
    const secondKeys = generatedKeys(secondRun.candidates)
    const freshRunsConsistent =
      firstKeys.length === secondKeys.length &&
      firstKeys.every((key, index) => key === secondKeys[index])
    const exactTarget = firstRun.candidates.find((candidate) => {
      const x = toGridMm(candidate.point.x)
      const y = toGridMm(candidate.point.y)
      return x === targetGridX && y === targetGridY
    })
    const exactTargetSourceMask = firstRun.provenance?.legalCandidateSources.find(
      ({ gridX, gridY }) => gridX === targetGridX && gridY === targetGridY
    )?.sourceMask
    const envelopeEventCandidates = yield* generateIntrinsicEnvelopeEventCandidates({
      state: input.parentState,
      moving,
      settings,
      nfpIfpService
    }).pipe(
      Effect.catchTag('IrregularNfpIfpControlAbortError', (error) =>
        Effect.fail(
          new IntrinsicQueueBeamDiscriminatorError({
            operation: 'measurement',
            message: error.message
          })
        )
      )
    )
    const exactTargetEnvelopeEventGenerated = envelopeEventCandidates.some((candidate) => {
      const x = toGridMm(candidate.point.x)
      const y = toGridMm(candidate.point.y)
      return x === targetGridX && y === targetGridY
    })
    const nearestGeneratedCandidate = firstRun.candidates
      .flatMap((candidate) => {
        const gridX = toGridMm(candidate.point.x)
        const gridY = toGridMm(candidate.point.y)
        if (gridX === undefined || gridY === undefined) return []
        const deltaX = gridX - targetGridX
        const deltaY = gridY - targetGridY
        return [{ gridX, gridY, squaredGridDistance: deltaX * deltaX + deltaY * deltaY }]
      })
      .toSorted(
        (first, second) =>
          first.squaredGridDistance - second.squaredGridDistance ||
          first.gridY - second.gridY ||
          first.gridX - second.gridX
      )[0]
    const auditBudget: AuditBudget = {
      startedAt: performance.now(),
      maximumRuntimeMs: Number.MAX_SAFE_INTEGER,
      maximumEvaluations: Number.MAX_SAFE_INTEGER,
      evaluations: 0,
      truncationReason: undefined
    }
    const targetScored = directLegal
      ? scoreAuditCandidate({
          state: input.parentState,
          piece: input.piece,
          remainingPreparedPieces: input.remainingPreparedPieces,
          budget: auditBudget,
          settings,
          geometryKernel,
          nfpIfpService,
          candidateMemoScope: new IrregularNfpIfpCandidateMemoScope(),
          control: { checkpoint: () => Effect.void },
          measureGapContainment: false,
          moving,
          candidate: targetCandidate,
          gapRegions: undefined
        })
      : undefined
    const targetCanonicalLegal =
      targetScored !== undefined && isCanonicalSheetlessStateLegal(targetScored.state)
    const targetMatchesExpectedCanonicalGeometry =
      targetCanonicalLegal &&
      targetScored.canonicalGeometryKey === input.expectedState.canonicalOccupiedGeometryKey
    const classification: IntrinsicReferenceSuccessorReachabilityAudit['classification'] =
      !directLegal
        ? 'direct-illegal-historical-pose'
        : exactTarget === undefined
          ? matchingVertexCount > 0
            ? 'raw-nfp-vertex-not-emitted'
            : matchingSegmentCount > 0
              ? 'missing-finite-boundary-feature'
              : 'not-on-current-nfp-boundary'
          : targetScored === undefined
            ? 'generated-but-scoring-rejected'
            : !targetCanonicalLegal
              ? 'generated-but-canonical-rejected'
              : !targetMatchesExpectedCanonicalGeometry
                ? 'generated-with-canonical-pose-delta'
                : 'reachable-exact-successor'
    return {
      pieceId,
      expectedCanonicalGeometryHash: digestSemanticIdentity(
        input.expectedState.canonicalOccupiedGeometryKey
      ),
      target: {
        transformFamily: transformFamilyKey(transform),
        gridX: targetGridX,
        gridY: targetGridY,
        parentAlignmentGridX: alignmentGridX,
        parentAlignmentGridY: alignmentGridY
      },
      directLegal,
      nfpBoundary: {
        fixedPieceCount: input.parentState.placedCollisionGeometries.length,
        matchingVertexCount,
        matchingSegmentCount,
        matchingSegments
      },
      envelopeAlignmentEvents,
      freshRunsConsistent,
      generatedCandidateCount: firstRun.candidates.length,
      exactTargetGenerated: exactTarget !== undefined,
      exactTargetSourceMask,
      envelopeEventCandidateCount: envelopeEventCandidates.length,
      exactTargetEnvelopeEventGenerated,
      nearestGeneratedCandidate,
      targetScored: targetScored !== undefined,
      targetCanonicalLegal,
      targetMatchesExpectedCanonicalGeometry,
      classification
    }
  })
}

function referenceParentAlignment(
  parentState: IrregularBeamState,
  expectedState: IrregularBeamState
): { readonly x: number; readonly y: number } | undefined {
  const firstParent = parentState.placedCollisionGeometries[0]
  if (firstParent === undefined) return { x: 0, y: 0 }
  const firstId = placedPieceId(firstParent)
  const firstExpected = expectedState.placedCollisionGeometries.find(
    (placed) => placedPieceId(placed) === firstId
  )
  if (firstExpected === undefined) return undefined
  const x =
    firstExpected.placement.transform.translateX - firstParent.placement.transform.translateX
  const y =
    firstExpected.placement.transform.translateY - firstParent.placement.transform.translateY
  for (const parent of parentState.placedCollisionGeometries) {
    const expected = expectedState.placedCollisionGeometries.find(
      (placed) => placedPieceId(placed) === placedPieceId(parent)
    )
    if (
      expected === undefined ||
      toGridMm(
        expected.placement.transform.translateX - parent.placement.transform.translateX - x
      ) !== 0 ||
      toGridMm(
        expected.placement.transform.translateY - parent.placement.transform.translateY - y
      ) !== 0
    ) {
      return undefined
    }
  }
  return { x, y }
}

function gridPointOnSegment(
  point: { readonly x: number; readonly y: number },
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number }
): boolean {
  const cross =
    BigInt(point.x - start.x) * BigInt(end.y - start.y) -
    BigInt(point.y - start.y) * BigInt(end.x - start.x)
  return (
    cross === 0n &&
    point.x >= Math.min(start.x, end.x) &&
    point.x <= Math.max(start.x, end.x) &&
    point.y >= Math.min(start.y, end.y) &&
    point.y <= Math.max(start.y, end.y)
  )
}

function referenceEnvelopeAlignmentEvents(input: {
  readonly parentState: IrregularBeamState
  readonly moving: TransformedCollisionGeometry
  readonly targetGridX: number
  readonly targetGridY: number
}): ReadonlyArray<string> {
  const occupied = input.parentState.translatedCollisionBounds
  if (occupied === undefined) return []
  const values = {
    'moving-min-x': addGrid(input.moving.bounds.minX, input.targetGridX),
    'moving-max-x': addGrid(input.moving.bounds.maxX, input.targetGridX),
    'moving-min-y': addGrid(input.moving.bounds.minY, input.targetGridY),
    'moving-max-y': addGrid(input.moving.bounds.maxY, input.targetGridY),
    'occupied-min-x': toGridMm(occupied.minX),
    'occupied-max-x': toGridMm(occupied.maxX),
    'occupied-min-y': toGridMm(occupied.minY),
    'occupied-max-y': toGridMm(occupied.maxY)
  } as const
  const pairs = [
    ['moving-min-x', 'occupied-min-x'],
    ['moving-min-x', 'occupied-max-x'],
    ['moving-max-x', 'occupied-min-x'],
    ['moving-max-x', 'occupied-max-x'],
    ['moving-min-y', 'occupied-min-y'],
    ['moving-min-y', 'occupied-max-y'],
    ['moving-max-y', 'occupied-min-y'],
    ['moving-max-y', 'occupied-max-y']
  ] as const
  return pairs.flatMap(([movingKey, occupiedKey]) =>
    values[movingKey] !== undefined && values[movingKey] === values[occupiedKey]
      ? [`${movingKey}=${occupiedKey}`]
      : []
  )
}

function addGrid(value: number, offset: number): number | undefined {
  const grid = toGridMm(value)
  return grid === undefined ? undefined : grid + offset
}

function candidateGridIdentity(candidate: IrregularPlacementCandidate): string {
  return `${toGridMm(candidate.point.x) ?? 'invalid'},${toGridMm(candidate.point.y) ?? 'invalid'}`
}

function circularDegreeDistance(first: number, second: number): number {
  const distance = Math.abs(((first - second) % 360 + 360) % 360)
  return Math.min(distance, 360 - distance)
}

/** Exact three-axis partial-layout measurement used only by the discriminator. */
export function measureIntrinsicQueueBeamAxes(
  state: IrregularBeamState
): IntrinsicQueueBeamAxes | undefined {
  const anchored = state.withBottomLeftAnchored()
  if (anchored === undefined || anchored.placedCollisionGeometries.length === 0) return undefined
  const sheet = intrinsicBoundsSheet(anchored)
  const structure = analyzeCanonicalLayoutStructure(sheet, anchored.placedCollisionGeometries)
  const envelope = measureCanonicalLayoutEnvelope(anchored.placedCollisionGeometries)
  const topology = measureCanonicalLayoutTopologyExact(anchored.placedCollisionGeometries)
  const cavities = measureCanonicalEnclosedCavities(anchored.placedCollisionGeometries)
  const contacts = measureCanonicalLayoutContacts(anchored.placedCollisionGeometries)
  if (
    structure === undefined ||
    envelope === undefined ||
    topology === undefined ||
    cavities === undefined ||
    contacts === undefined
  ) {
    return undefined
  }
  const largestComponent = new Set(structure.positiveContactComponents[0] ?? [])
  const occupiedAreaOutsideLargest = structure.pieces.reduce(
    (sum, piece) => sum + (largestComponent.has(piece.pieceId) ? 0 : piece.areaGrid2),
    0
  )
  const occupiedDoubledAreaGrid2 = Math.round(
    structure.pieces.reduce((sum, piece) => sum + piece.areaGrid2, 0) * 2
  )
  const occupiedHullWasteDoubledAreaGrid2 = topology.hullDoubledAreaGrid2 - occupiedDoubledAreaGrid2
  const axes: IntrinsicQueueBeamAxes = {
    compactness: {
      maximumSideGrid: Math.round(envelope.maximumSideMm * 1_000),
      envelopeAreaGrid2: Math.round(envelope.areaMm2 * 1_000_000),
      spanGrid: Math.round(envelope.spanMm * 1_000)
    },
    fragmentation: {
      occupiedDoubledAreaOutsideLargestComponentGrid2: Math.round(occupiedAreaOutsideLargest * 2),
      isolatedPieceCount: topology.topology.isolatedPieceCount,
      positiveContactComponentCount: topology.topology.positiveContactComponentCount,
      negativeLargestPositiveContactComponentSize:
        -topology.topology.largestPositiveContactComponentSize,
      totalStructuralContacts: contacts.totalStructuralContacts,
      dominantStructuralContacts: contacts.dominantStructuralContacts
    },
    voids: {
      enclosedCavityCount: cavities.count,
      totalEnclosedCavityDoubledAreaGrid2: Math.round(cavities.totalAreaMm2 * 2_000_000),
      largestHullGapDoubledAreaGrid2: topology.hullGapDoubledAreaGrid2,
      occupiedHullDoubledAreaGrid2: topology.hullDoubledAreaGrid2,
      occupiedHullWasteDoubledAreaGrid2,
      occupiedDoubledAreaGrid2
    }
  }
  return allAxisValuesFinite(axes) ? axes : undefined
}

/** Geometric dominance over compactness and void/cohesion compound axes. */
export function intrinsicQueueBeamAxesDominate(
  first: IntrinsicQueueBeamAxes,
  second: IntrinsicQueueBeamAxes
): boolean {
  const comparisons = [compareCompactness(first, second), compareVoids(first, second)]
  return (
    comparisons.every((comparison) => comparison <= 0) &&
    comparisons.some((comparison) => comparison < 0)
  )
}

export function assessIntrinsicQueueCandidate(
  candidate: Pick<IntrinsicQueueBeamCandidateWitness, 'canonicalGeometryKey' | 'axes'>,
  scheduledSuccessors: ReadonlyArray<
    Pick<IntrinsicQueueBeamCandidateWitness, 'canonicalGeometryKey' | 'axes'>
  >
): { readonly paretoHeadroom: boolean; readonly strictImprovement: boolean } {
  const distinct = scheduledSuccessors.every(
    ({ canonicalGeometryKey }) => canonicalGeometryKey !== candidate.canonicalGeometryKey
  )
  if (!distinct || scheduledSuccessors.length === 0) {
    return { paretoHeadroom: false, strictImprovement: false }
  }
  return {
    paretoHeadroom: !scheduledSuccessors.some((scheduled) =>
      intrinsicQueueBeamAxesDominate(scheduled.axes, candidate.axes)
    ),
    strictImprovement: scheduledSuccessors.every((scheduled) =>
      intrinsicQueueBeamAxesDominate(candidate.axes, scheduled.axes)
    )
  }
}

export function assessIntrinsicBeamContinuation(
  candidate: Pick<IntrinsicQueueBeamCandidateWitness, 'canonicalGeometryKey' | 'axes'>,
  selected: Pick<IntrinsicQueueBeamCandidateWitness, 'canonicalGeometryKey' | 'axes'> | undefined
): { readonly paretoHeadroom: boolean; readonly strictImprovement: boolean } {
  if (selected === undefined) return { paretoHeadroom: true, strictImprovement: true }
  if (selected.canonicalGeometryKey === candidate.canonicalGeometryKey) {
    return { paretoHeadroom: false, strictImprovement: false }
  }
  return {
    paretoHeadroom: !intrinsicQueueBeamAxesDominate(selected.axes, candidate.axes),
    strictImprovement: intrinsicQueueBeamAxesDominate(candidate.axes, selected.axes)
  }
}

export function classifyIntrinsicQueueBeamHeadroom(
  queueHeadroom: boolean,
  beamHeadroom: boolean
): IntrinsicQueueBeamClassification {
  if (queueHeadroom && beamHeadroom) return 'both'
  if (queueHeadroom) return 'queue-headroom'
  if (beamHeadroom) return 'beam-headroom'
  return 'neither'
}

export function boundIntrinsicDiscriminatorWitnesses<T>(
  witnesses: ReadonlyArray<T>,
  maximumWitnesses = DEFAULT_WITNESS_LIMIT
): ReadonlyArray<T> {
  return witnesses.slice(0, Math.max(0, Math.floor(maximumWitnesses)))
}

function nondominatedFrontier(
  candidates: ReadonlyArray<AuditCandidate>
): ReadonlyArray<AuditCandidate> {
  return orderCandidates(
    candidates.filter(
      (candidate) =>
        !candidates.some(
          (other) =>
            other !== candidate && intrinsicQueueBeamAxesDominate(other.axes, candidate.axes)
        )
    )
  )
}

function nondominatedLayers(
  candidates: ReadonlyArray<AuditCandidate>
): ReadonlyArray<ReadonlyArray<AuditCandidate>> {
  const remaining = new Map(
    candidates.map((candidate) => [candidate.canonicalGeometryKey, candidate] as const)
  )
  const layers: Array<ReadonlyArray<AuditCandidate>> = []
  while (remaining.size > 0) {
    const layer = nondominatedFrontier([...remaining.values()])
    if (layer.length === 0) break
    layers.push(layer)
    for (const candidate of layer) remaining.delete(candidate.canonicalGeometryKey)
  }
  return layers
}

function findCandidateLayer(
  layers: ReadonlyArray<ReadonlyArray<AuditCandidate>>,
  canonicalGeometryKey: string
): number | undefined {
  const index = layers.findIndex((layer) =>
    layer.some((candidate) => candidate.canonicalGeometryKey === canonicalGeometryKey)
  )
  return index < 0 ? undefined : index
}

function selectCalibrationCapacity(
  candidates: ReadonlyArray<AuditCandidate>,
  protectedControl: AuditCandidate | undefined,
  totalCapacity: 1 | 2 | 4 | 8 | 13
): ReadonlyArray<AuditCandidate> {
  const selected = new Map<string, AuditCandidate>()
  if (protectedControl !== undefined) {
    selected.set(protectedControl.canonicalGeometryKey, protectedControl)
  }
  const experimentalWidth = totalCapacity - 1
  if (experimentalWidth <= 0) return [...selected.values()]
  const layers = nondominatedLayers(candidates)
  const laterLayerSlots = Math.ceil(experimentalWidth / 2)
  for (const layer of layers.slice(1, 1 + laterLayerSlots)) {
    const representative = orderCandidates(layer)[0]
    if (representative !== undefined) {
      selected.set(representative.canonicalGeometryKey, representative)
    }
  }
  const fillOrder = [...(layers[0] ?? []), ...layers.slice(1 + laterLayerSlots).flat()]
  for (const candidate of orderCandidates(fillOrder)) {
    if (selected.size >= totalCapacity) break
    selected.set(candidate.canonicalGeometryKey, candidate)
  }
  return [...selected.values()]
}

export interface IntrinsicPartialGeometricBeamCandidate {
  readonly futureEquivalenceKey: string
  readonly parentFutureEquivalenceKey?: string
  readonly canonicalGeometryKey: string
  readonly axes: IntrinsicQueueBeamAxes
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
}

export interface IntrinsicPartialGeometricBeamSelection<T> {
  readonly retained: ReadonlyArray<T>
  readonly diagnostics: {
    readonly inputCandidateCount: number
    readonly futureDeduplicatedCandidateCount: number
    readonly protectedCandidateExcludedCount: number
    readonly selectableCandidateCount: number
    readonly paretoLayerSizes: ReadonlyArray<number>
    readonly paretoLayerExtractionComplete: boolean
    readonly unlayeredCandidateCount: number
  }
  readonly slots: ReadonlyArray<{
    readonly role: IntrinsicPartialGeometricBeamRole
    readonly layer: number
    readonly visit: number
    readonly futureEquivalenceKey: string
    readonly parentFutureEquivalenceKey: string | undefined
    readonly canonicalGeometryKey: string
    readonly axes: IntrinsicQueueBeamAxes
    readonly dispersion:
      | {
          readonly nearestRetainedFutureEquivalenceKey: string
          readonly voidHamming: number
          readonly contactHamming: number
          readonly symmetricDifferenceNumerator: string
          readonly pairUnionDenominator: string
          readonly symmetricDifferenceRatio: number
        }
      | undefined
  }>
}

interface IntrinsicOccupiedDistance {
  readonly voidHamming: number
  readonly contactHamming: number
  readonly symmetricDifferenceNumerator: bigint
  readonly pairUnionDenominator: bigint
}

/** Deterministic Stage 2A retention over one synchronized global successor union. */
export function selectIntrinsicPartialGeometricBeam<
  T extends IntrinsicPartialGeometricBeamCandidate
>(input: {
  readonly candidates: ReadonlyArray<T>
  readonly experimentalWidth: number
  readonly protectedControl?: T
}): IntrinsicPartialGeometricBeamSelection<T> {
  const experimentalWidth = Math.max(0, Math.floor(input.experimentalWidth))
  const unique = new Map<string, T>()
  for (const candidate of input.candidates) {
    const incumbent = unique.get(candidate.futureEquivalenceKey)
    if (incumbent === undefined || comparePartialCandidate(candidate, incumbent) < 0) {
      unique.set(candidate.futureEquivalenceKey, candidate)
    }
  }
  const protectedKey = input.protectedControl?.futureEquivalenceKey
  const selectable = [...unique.values()].filter(
    ({ futureEquivalenceKey }) => futureEquivalenceKey !== protectedKey
  )
  const layers = partialNondominatedLayers(
    selectable,
    Math.min(experimentalWidth, selectable.length)
  )
  const layeredCandidateCount = layers.reduce((sum, layer) => sum + layer.length, 0)
  const initialBreadth = Math.min(layers.length, Math.ceil(experimentalWidth / 2))
  let representedLayerCount = initialBreadth
  const retained: T[] = []
  const slots: Array<IntrinsicPartialGeometricBeamSelection<T>['slots'][number]> = []
  const selectedKeys = new Set<string>()
  const visits = new Map<number, number>()
  const append = (
    candidate: T | undefined,
    role: IntrinsicPartialGeometricBeamRole,
    dispersion?: OccupiedDispersionWitness
  ) => {
    if (candidate === undefined || selectedKeys.has(candidate.futureEquivalenceKey)) return false
    const layer = Math.max(
      0,
      layers.findIndex((members) => members.includes(candidate))
    )
    const visit = (visits.get(layer) ?? 0) + 1
    visits.set(layer, visit)
    selectedKeys.add(candidate.futureEquivalenceKey)
    retained.push(candidate)
    slots.push({
      role,
      layer,
      visit,
      futureEquivalenceKey: candidate.futureEquivalenceKey,
      parentFutureEquivalenceKey: candidate.parentFutureEquivalenceKey,
      canonicalGeometryKey: candidate.canonicalGeometryKey,
      axes: candidate.axes,
      dispersion: dispersion === undefined ? undefined : serializeOccupiedDispersion(dispersion)
    })
    return true
  }

  for (let layerIndex = 0; layerIndex < initialBreadth; layerIndex += 1) {
    append(
      layers[layerIndex]
        ?.filter(({ futureEquivalenceKey }) => !selectedKeys.has(futureEquivalenceKey))
        .toSorted(comparePartialCandidate)[0],
      'breadth'
    )
  }

  let remaining = experimentalWidth - retained.length
  if (remaining >= 2) {
    const contact = selectable
      .filter(({ futureEquivalenceKey }) => !selectedKeys.has(futureEquivalenceKey))
      .toSorted(comparePartialContactCandidate)[0]
    if (append(contact, 'contact')) remaining -= 1
  }

  const retainedForDistance = (): ReadonlyArray<T> =>
    input.protectedControl === undefined ? retained : [input.protectedControl, ...retained]
  while (remaining > 0 && representedLayerCount > 0) {
    let addedInCycle = false
    for (
      let layerIndex = representedLayerCount - 1;
      layerIndex >= 0 && remaining > 0;
      layerIndex -= 1
    ) {
      const available = layers[layerIndex]?.filter(
        ({ futureEquivalenceKey }) => !selectedKeys.has(futureEquivalenceKey)
      )
      const next = selectMostDispersedCandidate(available ?? [], retainedForDistance())
      if (!append(next?.candidate, 'dispersion', next?.witness)) continue
      remaining -= 1
      addedInCycle = true
    }
    if (addedInCycle) continue
    const nextLayer = layers[representedLayerCount]
    representedLayerCount += 1
    const nextBreadthCandidate = nextLayer
      ?.filter(({ futureEquivalenceKey }) => !selectedKeys.has(futureEquivalenceKey))
      .toSorted(comparePartialCandidate)[0]
    if (!append(nextBreadthCandidate, 'breadth')) break
    remaining -= 1
  }

  return {
    retained,
    diagnostics: {
      inputCandidateCount: input.candidates.length,
      futureDeduplicatedCandidateCount: unique.size,
      protectedCandidateExcludedCount: Number(
        protectedKey !== undefined && unique.has(protectedKey)
      ),
      selectableCandidateCount: selectable.length,
      paretoLayerSizes: layers.map((layer) => layer.length),
      paretoLayerExtractionComplete: layeredCandidateCount === selectable.length,
      unlayeredCandidateCount: selectable.length - layeredCandidateCount
    },
    slots
  }
}

function partialNondominatedLayers<T extends IntrinsicPartialGeometricBeamCandidate>(
  candidates: ReadonlyArray<T>,
  maximumLayerCount = Number.POSITIVE_INFINITY
): ReadonlyArray<ReadonlyArray<T>> {
  const remaining = new Map(
    candidates.map((candidate) => [candidate.futureEquivalenceKey, candidate] as const)
  )
  const layers: Array<ReadonlyArray<T>> = []
  while (remaining.size > 0 && layers.length < maximumLayerCount) {
    const values = [...remaining.values()]
    const layer = values
      .filter(
        (candidate) =>
          !values.some(
            (other) =>
              other !== candidate && intrinsicQueueBeamAxesDominate(other.axes, candidate.axes)
          )
      )
      .toSorted(comparePartialCandidate)
    if (layer.length === 0) break
    layers.push(layer)
    for (const candidate of layer) remaining.delete(candidate.futureEquivalenceKey)
  }
  return layers
}

function comparePartialCandidate(
  first: IntrinsicPartialGeometricBeamCandidate,
  second: IntrinsicPartialGeometricBeamCandidate
): number {
  return (
    compareCompactness(first.axes, second.axes) ||
    compareVoids(first.axes, second.axes) ||
    first.futureEquivalenceKey.localeCompare(second.futureEquivalenceKey)
  )
}

function comparePartialContactCandidate(
  first: IntrinsicPartialGeometricBeamCandidate,
  second: IntrinsicPartialGeometricBeamCandidate
): number {
  return (
    compareBoundedContact(first.axes, second.axes) ||
    compareCompactness(first.axes, second.axes) ||
    compareVoids(first.axes, second.axes) ||
    first.futureEquivalenceKey.localeCompare(second.futureEquivalenceKey)
  )
}

function compareBoundedContact(
  first: IntrinsicQueueBeamAxes,
  second: IntrinsicQueueBeamAxes
): number {
  return (
    first.fragmentation.isolatedPieceCount - second.fragmentation.isolatedPieceCount ||
    first.fragmentation.positiveContactComponentCount -
      second.fragmentation.positiveContactComponentCount ||
    first.fragmentation.negativeLargestPositiveContactComponentSize -
      second.fragmentation.negativeLargestPositiveContactComponentSize ||
    second.fragmentation.totalStructuralContacts -
      first.fragmentation.totalStructuralContacts ||
    second.fragmentation.dominantStructuralContacts -
      first.fragmentation.dominantStructuralContacts
  )
}

function selectMostDispersedCandidate<T extends IntrinsicPartialGeometricBeamCandidate>(
  candidates: ReadonlyArray<T>,
  retained: ReadonlyArray<T>
):
  | { readonly candidate: T; readonly witness: OccupiedDispersionWitness | undefined }
  | undefined {
  const ranked = candidates.map((candidate) => ({
    candidate,
    witness: minimumOccupiedDistance(candidate, retained)
  }))
  return ranked.toSorted((first, second) => {
    if (first.witness === undefined || second.witness === undefined) {
      return first.witness === undefined
        ? second.witness === undefined
          ? first.candidate.futureEquivalenceKey.localeCompare(
              second.candidate.futureEquivalenceKey
            )
          : 1
        : -1
    }
    return (
      compareOccupiedDistance(second.witness.distance, first.witness.distance) ||
      first.candidate.futureEquivalenceKey.localeCompare(second.candidate.futureEquivalenceKey)
    )
  })[0]
}

interface OccupiedDispersionWitness {
  readonly nearestRetainedFutureEquivalenceKey: string
  readonly distance: IntrinsicOccupiedDistance
}

function minimumOccupiedDistance(
  candidate: IntrinsicPartialGeometricBeamCandidate,
  retained: ReadonlyArray<IntrinsicPartialGeometricBeamCandidate>
): OccupiedDispersionWitness | undefined {
  const distances = retained.flatMap((member) => {
    const distance = occupiedDistance(candidate, member)
    return distance === undefined
      ? []
      : [{ nearestRetainedFutureEquivalenceKey: member.futureEquivalenceKey, distance }]
  })
  return distances.toSorted((first, second) =>
    compareOccupiedDistance(first.distance, second.distance)
  )[0]
}

function serializeOccupiedDispersion(witness: OccupiedDispersionWitness) {
  const { distance } = witness
  return {
    nearestRetainedFutureEquivalenceKey: witness.nearestRetainedFutureEquivalenceKey,
    voidHamming: distance.voidHamming,
    contactHamming: distance.contactHamming,
    symmetricDifferenceNumerator: distance.symmetricDifferenceNumerator.toString(),
    pairUnionDenominator: distance.pairUnionDenominator.toString(),
    symmetricDifferenceRatio:
      Number(distance.symmetricDifferenceNumerator) / Number(distance.pairUnionDenominator)
  }
}

function occupiedDistance(
  first: IntrinsicPartialGeometricBeamCandidate,
  second: IntrinsicPartialGeometricBeamCandidate
): IntrinsicOccupiedDistance | undefined {
  const firstVoid = voidSignature(first.axes)
  const secondVoid = voidSignature(second.axes)
  const firstContact = contactSignature(first.axes)
  const secondContact = contactSignature(second.axes)
  const ratios = ([0, 90, 180, 270] as const).flatMap((rotationDeg) => {
    const ratio = occupiedSymmetricDifferenceRatio(
      first.placedCollisionGeometries,
      second.placedCollisionGeometries,
      rotationDeg
    )
    return ratio === undefined ? [] : [ratio]
  })
  const ratio = ratios.toSorted(compareExactFraction)[0]
  if (ratio === undefined) return undefined
  return {
    voidHamming: hammingDistance(firstVoid, secondVoid),
    contactHamming: hammingDistance(firstContact, secondContact),
    symmetricDifferenceNumerator: ratio.numerator,
    pairUnionDenominator: ratio.denominator
  }
}

function voidSignature(axes: IntrinsicQueueBeamAxes): ReadonlyArray<number> {
  return [
    axes.voids.enclosedCavityCount,
    axes.voids.totalEnclosedCavityDoubledAreaGrid2,
    axes.voids.largestHullGapDoubledAreaGrid2,
    axes.voids.occupiedHullWasteDoubledAreaGrid2
  ]
}

function contactSignature(axes: IntrinsicQueueBeamAxes): ReadonlyArray<number> {
  return [
    axes.fragmentation.isolatedPieceCount,
    axes.fragmentation.positiveContactComponentCount,
    axes.fragmentation.negativeLargestPositiveContactComponentSize,
    axes.fragmentation.totalStructuralContacts,
    axes.fragmentation.dominantStructuralContacts
  ]
}

function hammingDistance(first: ReadonlyArray<number>, second: ReadonlyArray<number>): number {
  return first.reduce(
    (distance, value, index) => distance + Number(value !== second[index]),
    0
  )
}

function compareOccupiedDistance(
  first: IntrinsicOccupiedDistance,
  second: IntrinsicOccupiedDistance
): number {
  return (
    first.voidHamming - second.voidHamming ||
    first.contactHamming - second.contactHamming ||
    compareExactFraction(
      {
        numerator: first.symmetricDifferenceNumerator,
        denominator: first.pairUnionDenominator
      },
      {
        numerator: second.symmetricDifferenceNumerator,
        denominator: second.pairUnionDenominator
      }
    )
  )
}

function compareExactFraction(
  first: { readonly numerator: bigint; readonly denominator: bigint },
  second: { readonly numerator: bigint; readonly denominator: bigint }
): number {
  const firstScaled = first.numerator * second.denominator
  const secondScaled = second.numerator * first.denominator
  return firstScaled < secondScaled ? -1 : firstScaled > secondScaled ? 1 : 0
}

function occupiedSymmetricDifferenceRatio(
  first: ReadonlyArray<IrregularPlacedPiece>,
  second: ReadonlyArray<IrregularPlacedPiece>,
  secondRotationDeg: 0 | 90 | 180 | 270
): { readonly numerator: bigint; readonly denominator: bigint } | undefined {
  const firstLayoutPaths = layoutGridPaths(first)
  const secondLayoutPaths = layoutGridPaths(second)
  if (firstLayoutPaths === undefined || secondLayoutPaths === undefined) return undefined
  const firstPaths = bottomLeftAnchorPaths(firstLayoutPaths)
  const secondPaths = bottomLeftAnchorPaths(
    secondLayoutPaths.map((path) =>
      path.map((point) => rotateQuarterTurnPoint(point, secondRotationDeg))
    )
  )
  if (firstPaths === undefined || secondPaths === undefined) return undefined
  const firstUnion = booleanPaths(ClipType.Union, firstPaths, null)
  const secondUnion = booleanPaths(ClipType.Union, secondPaths, null)
  if (firstUnion === undefined || secondUnion === undefined) return undefined
  const symmetricDifference = booleanPaths(ClipType.Xor, firstUnion, secondUnion)
  const pairUnion = booleanPaths(ClipType.Union, firstUnion, secondUnion)
  if (symmetricDifference === undefined || pairUnion === undefined) return undefined
  const numerator = measureExactDoubledPathsArea(symmetricDifference)
  const denominator = measureExactDoubledPathsArea(pairUnion)
  if (numerator === undefined || denominator === undefined || denominator <= 0n) return undefined
  return { numerator, denominator }
}

function layoutGridPaths(
  placed: ReadonlyArray<IrregularPlacedPiece>
): ReadonlyArray<Path64> | undefined {
  const paths: Path64[] = []
  for (const entry of placed) {
    const path = placedCollisionWorldGridPath(entry)
    if (path === undefined) return undefined
    paths.push(path.map(({ x, y }) => ({ x, y })))
  }
  return paths
}

function bottomLeftAnchorPaths(paths: ReadonlyArray<Path64>): ReadonlyArray<Path64> | undefined {
  const first = paths[0]?.[0]
  if (first === undefined) return paths.length === 0 ? [] : undefined
  let minX = first.x
  let minY = first.y
  for (const point of paths.flat()) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
  }
  return paths.map((path) => path.map(({ x, y }) => ({ x: x - minX, y: y - minY })))
}

function rotateQuarterTurnPoint(
  point: { readonly x: number; readonly y: number },
  rotationDeg: 0 | 90 | 180 | 270
): { readonly x: number; readonly y: number } {
  switch (rotationDeg) {
    case 0:
      return point
    case 90:
      return { x: -point.y, y: point.x }
    case 180:
      return { x: -point.x, y: -point.y }
    case 270:
      return { x: point.y, y: -point.x }
  }
}

function booleanPaths(
  clipType: ClipType,
  subject: ReadonlyArray<Path64>,
  clip: ReadonlyArray<Path64> | null
): ReadonlyArray<Path64> | undefined {
  const tree = new PolyTree64()
  try {
    booleanOpWithPolyTree(clipType, [...subject], clip === null ? null : [...clip], tree, FillRule.NonZero)
  } catch {
    return undefined
  }
  return polyTreeToPaths64(tree)
}

/** Exact signed-contour area for integer Clipper paths. */
export function measureExactDoubledPathsArea(
  paths: ReadonlyArray<ReadonlyArray<{ readonly x: number; readonly y: number }>>
): bigint | undefined {
  let total = 0n
  for (const path of paths) {
    if (path.length < 3) continue
    let previous = path[path.length - 1]
    if (previous === undefined) continue
    for (const point of path) {
      if (
        !Number.isSafeInteger(previous.x) ||
        !Number.isSafeInteger(previous.y) ||
        !Number.isSafeInteger(point.x) ||
        !Number.isSafeInteger(point.y)
      ) {
        return undefined
      }
      total += BigInt(previous.x) * BigInt(point.y) - BigInt(point.x) * BigInt(previous.y)
      previous = point
    }
  }
  return total < 0n ? -total : total
}

function summarizeDelayedLineage(
  steps: ReadonlyArray<IntrinsicQueueBeamStepReport>,
  provided: boolean,
  firstMissingDepth: number | undefined
): IntrinsicQueueBeamDiscriminatorResult['delayedLineage'] {
  const reports = steps.flatMap(({ delayedLineage }) =>
    delayedLineage === undefined ? [] : [delayedLineage]
  )
  const capacities = [1, 2, 4, 8, 13] as const
  const minimumObservedSurvivalCapacity = capacities.find(
    (capacity) =>
      reports.length > 0 &&
      reports.every(
        ({ survivesAtTotalCapacities }) => survivesAtTotalCapacities[capacityKey(capacity)]
      )
  )
  const experimentalWidths = [0, 1, 3, 7, 12] as const
  const minimumObservedExperimentalWidth = experimentalWidths.find(
    (width) =>
      reports.length > 0 &&
      reports.every(
        ({ survivesAtExperimentalWidths }) =>
          survivesAtExperimentalWidths[String(width) as keyof typeof survivesAtExperimentalWidths]
      )
  )
  return {
    provided,
    matchedDepthCount: reports.filter(({ generated }) => generated).length,
    firstMissingDepth,
    minimumObservedSurvivalCapacity,
    minimumObservedExperimentalWidth
  }
}

function capacityKey(capacity: 1 | 2 | 4 | 8 | 13): '1' | '2' | '4' | '8' | '13' {
  return String(capacity) as '1' | '2' | '4' | '8' | '13'
}

function rankWitnesses(
  candidates: ReadonlyArray<AuditCandidate>,
  frontier: ReadonlyArray<AuditCandidate>
): ReadonlyArray<IntrinsicQueueBeamRankedWitness> {
  const orderedFrontier = orderCandidates(frontier)
  return orderCandidates(candidates).map((candidate) => ({
    ...candidateWitness(candidate),
    compactnessRank: compoundAxisRank(candidates, candidate, compareCompactness),
    fragmentationRank: compoundAxisRank(candidates, candidate, compareFragmentation),
    voidRank: compoundAxisRank(candidates, candidate, compareVoids),
    frontierRank:
      orderedFrontier.findIndex(
        ({ canonicalGeometryKey }) => canonicalGeometryKey === candidate.canonicalGeometryKey
      ) + 1 || undefined
  }))
}

function compoundAxisRank(
  candidates: ReadonlyArray<AuditCandidate>,
  candidate: AuditCandidate,
  compare: (first: IntrinsicQueueBeamAxes, second: IntrinsicQueueBeamAxes) => number
): number {
  return 1 + candidates.filter((other) => compare(other.axes, candidate.axes) < 0).length
}

function orderCandidates(candidates: ReadonlyArray<AuditCandidate>): ReadonlyArray<AuditCandidate> {
  return candidates.toSorted(
    (first, second) =>
      compareCompactness(first.axes, second.axes) ||
      compareFragmentation(first.axes, second.axes) ||
      compareVoids(first.axes, second.axes) ||
      compareCandidateIdentity(first, second)
  )
}

function compareCompactness(first: IntrinsicQueueBeamAxes, second: IntrinsicQueueBeamAxes): number {
  return (
    first.compactness.maximumSideGrid - second.compactness.maximumSideGrid ||
    first.compactness.envelopeAreaGrid2 - second.compactness.envelopeAreaGrid2 ||
    first.compactness.spanGrid - second.compactness.spanGrid
  )
}

function compareFragmentation(
  first: IntrinsicQueueBeamAxes,
  second: IntrinsicQueueBeamAxes
): number {
  return (
    first.fragmentation.occupiedDoubledAreaOutsideLargestComponentGrid2 -
      second.fragmentation.occupiedDoubledAreaOutsideLargestComponentGrid2 ||
    first.fragmentation.isolatedPieceCount - second.fragmentation.isolatedPieceCount ||
    first.fragmentation.positiveContactComponentCount -
      second.fragmentation.positiveContactComponentCount ||
    first.fragmentation.negativeLargestPositiveContactComponentSize -
      second.fragmentation.negativeLargestPositiveContactComponentSize
  )
}

function compareVoids(first: IntrinsicQueueBeamAxes, second: IntrinsicQueueBeamAxes): number {
  return (
    first.voids.enclosedCavityCount - second.voids.enclosedCavityCount ||
    first.voids.totalEnclosedCavityDoubledAreaGrid2 -
      second.voids.totalEnclosedCavityDoubledAreaGrid2 ||
    compareExactRatio(
      first.voids.largestHullGapDoubledAreaGrid2,
      first.voids.occupiedHullDoubledAreaGrid2,
      second.voids.largestHullGapDoubledAreaGrid2,
      second.voids.occupiedHullDoubledAreaGrid2
    ) ||
    compareExactRatio(
      first.voids.occupiedHullWasteDoubledAreaGrid2,
      first.voids.occupiedHullDoubledAreaGrid2,
      second.voids.occupiedHullWasteDoubledAreaGrid2,
      second.voids.occupiedHullDoubledAreaGrid2
    ) ||
    first.voids.occupiedHullWasteDoubledAreaGrid2 - second.voids.occupiedHullWasteDoubledAreaGrid2
  )
}

function compareExactRatio(
  firstNumerator: number,
  firstDenominator: number,
  secondNumerator: number,
  secondDenominator: number
): number {
  if (firstDenominator === 0 || secondDenominator === 0) {
    return firstDenominator === secondDenominator ? 0 : firstDenominator === 0 ? -1 : 1
  }
  const first = BigInt(firstNumerator) * BigInt(secondDenominator)
  const second = BigInt(secondNumerator) * BigInt(firstDenominator)
  return first < second ? -1 : first > second ? 1 : 0
}

function isNonInertGapCandidate(parent: IrregularBeamState, candidate: AuditCandidate): boolean {
  if (candidate.containingGap === undefined) return false
  const beforeAxes = measureIntrinsicQueueBeamAxes(parent)
  if (beforeAxes === undefined) return false
  const beforeGaps = deriveCanonicalIntrinsicGapRegions(parent.placedCollisionGeometries)
  const afterGaps = deriveCanonicalIntrinsicGapRegions(candidate.state.placedCollisionGeometries)
  if (beforeGaps === undefined || afterGaps === undefined) return false
  const beforeGapDoubledArea = Math.round(
    beforeGaps.reduce((sum, region) => sum + region.areaMm2, 0) * 2_000_000
  )
  const afterGapDoubledArea = Math.round(
    afterGaps.reduce((sum, region) => sum + region.areaMm2, 0) * 2_000_000
  )
  const beforeSharedBoundary = parent.sharedCollisionBoundaryLengthMm ?? 0
  const afterSharedBoundary = candidate.state.sharedCollisionBoundaryLengthMm ?? 0
  return (
    afterSharedBoundary > beforeSharedBoundary &&
    candidate.axes.compactness.maximumSideGrid === beforeAxes.compactness.maximumSideGrid &&
    candidate.axes.compactness.envelopeAreaGrid2 === beforeAxes.compactness.envelopeAreaGrid2 &&
    afterGapDoubledArea < beforeGapDoubledArea
  )
}

function distinctGeometryClassRepresentatives(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): ReadonlyArray<IrregularPreparedPiece> {
  const representatives = new Map<string, IrregularPreparedPiece>()
  for (const piece of pieces) {
    const key = intrinsicPreparedPieceClassKey(piece)
    const incumbent = representatives.get(key)
    if (
      incumbent === undefined ||
      preparedPieceId(piece).localeCompare(preparedPieceId(incumbent)) < 0
    ) {
      representatives.set(key, piece)
    }
  }
  return [...representatives.entries()]
    .toSorted((first, second) => first[0].localeCompare(second[0]))
    .map(([, piece]) => piece)
}

function countClassifications(
  steps: ReadonlyArray<IntrinsicQueueBeamStepReport>
): Readonly<Record<IntrinsicQueueBeamClassification, number>> {
  const result: Record<IntrinsicQueueBeamClassification, number> = {
    'queue-headroom': 0,
    'beam-headroom': 0,
    both: 0,
    neither: 0
  }
  for (const step of steps) result[step.classification] += 1
  return result
}

function auditRuntimeExpired(budget: AuditBudget): boolean {
  if (performance.now() - budget.startedAt < budget.maximumRuntimeMs) return false
  budget.truncationReason = 'maximum-runtime'
  return true
}

function takeAuditEvaluation(budget: AuditBudget): boolean {
  if (budget.evaluations >= budget.maximumEvaluations) {
    budget.truncationReason = 'maximum-evaluations'
    return false
  }
  budget.evaluations += 1
  return true
}

function allAxisValuesFinite(axes: IntrinsicQueueBeamAxes): boolean {
  return [
    ...Object.values(axes.compactness),
    ...Object.values(axes.fragmentation),
    ...Object.values(axes.voids)
  ].every(Number.isFinite)
}

function candidateWitness(candidate: AuditCandidate): IntrinsicQueueBeamCandidateWitness {
  return {
    pieceId: candidate.pieceId,
    transformFamily: candidate.transformFamily,
    gridPoint: candidate.gridPoint,
    canonicalGeometryKey: candidate.canonicalGeometryKey,
    axes: candidate.axes
  }
}

function compareCandidateIdentity(
  first: UnmeasuredAuditCandidate,
  second: UnmeasuredAuditCandidate
): number {
  return (
    first.canonicalGeometryKey.localeCompare(second.canonicalGeometryKey) ||
    first.transformFamily.localeCompare(second.transformFamily) ||
    first.gridPoint.y - second.gridPoint.y ||
    first.gridPoint.x - second.gridPoint.x ||
    first.pieceId.localeCompare(second.pieceId)
  )
}

function compareLocalScore(
  first: IntrinsicStrictLocalScore,
  second: IntrinsicStrictLocalScore
): number {
  return (
    Math.round(first.maximumSideMm * 1_000) - Math.round(second.maximumSideMm * 1_000) ||
    Math.round(first.envelopeAreaMm2 * 1_000_000) -
      Math.round(second.envelopeAreaMm2 * 1_000_000) ||
    Math.round(first.envelopeSpanMm * 1_000) - Math.round(second.envelopeSpanMm * 1_000) ||
    second.sharedBoundaryLengthMm - first.sharedBoundaryLengthMm ||
    first.canonicalCombinedGeometryKey.localeCompare(second.canonicalCombinedGeometryKey)
  )
}

function intrinsicBoundsSheet(state: IrregularBeamState): SheetSpec {
  const bounds = state.translatedCollisionBounds
  return new SheetSpec({
    width: Math.max(1, Math.ceil(bounds?.maxX ?? 0)),
    height: Math.max(1, Math.ceil(bounds?.maxY ?? 0)),
    label: 'intrinsic-queue-beam-audit-bounds'
  })
}

function isCanonicalSheetlessStateLegal(state: IrregularBeamState): boolean {
  const anchored = state.withBottomLeftAnchored()
  return (
    anchored !== undefined &&
    assertCanonicalGridLegalLayout(
      intrinsicBoundsSheet(anchored),
      anchored.placedCollisionGeometries
    )
  )
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function placedPieceId(piece: IrregularPlacedPiece): PieceId {
  return piece.placement.pieceId ?? piece.placement.sourcePieceId
}

function makePlacement(
  piece: IrregularPreparedPiece,
  candidate: IrregularPlacementCandidate
): IrregularPlacement {
  const placement = {
    sourcePieceId: piece.source.id,
    placementReference: piece.collisionGeometry.placementReference,
    transform: new IrregularTransform({
      translateX: candidate.point.x,
      translateY: candidate.point.y,
      rotationDeg: candidate.transform.rotationDeg,
      mirrored: candidate.transform.mirrored
    })
  }
  return piece.pieceId === undefined
    ? new IrregularPlacement(placement)
    : new IrregularPlacement({ ...placement, pieceId: piece.pieceId })
}

function transformFamilyKey(transform: IrregularTransformCandidate): string {
  const remainder = transform.rotationDeg % 360
  const rotationDeg = remainder < 0 ? remainder + 360 : remainder
  return `${Object.is(rotationDeg, -0) ? 0 : rotationDeg}:${Number(transform.mirrored)}`
}

function originAnchorCandidates(
  moving: TransformedCollisionGeometry
): ReadonlyArray<IrregularPlacementCandidate> {
  const gridX = toGridMm(-moving.bounds.minX)
  const gridY = toGridMm(-moving.bounds.minY)
  if (gridX === undefined || gridY === undefined) return []
  return [
    new IrregularPlacementCandidate({
      pieceId: moving.sourcePieceId,
      transform: moving.transform,
      point: { x: fromGrid(gridX), y: fromGrid(gridY) },
      diagnostics: []
    })
  ]
}

function canonicalCollisionAreaMm2(moving: TransformedCollisionGeometry): number | undefined {
  let doubledAreaGrid2 = 0
  for (let index = 0; index < moving.polygon.points.length; index += 1) {
    const first = moving.polygon.points[index]
    const second = moving.polygon.points[(index + 1) % moving.polygon.points.length]
    if (first === undefined || second === undefined) return undefined
    const firstX = toGridMm(first.x)
    const firstY = toGridMm(first.y)
    const secondX = toGridMm(second.x)
    const secondY = toGridMm(second.y)
    if (
      firstX === undefined ||
      firstY === undefined ||
      secondX === undefined ||
      secondY === undefined
    ) {
      return undefined
    }
    doubledAreaGrid2 += firstX * secondY - secondX * firstY
  }
  const areaMm2 = Math.abs(doubledAreaGrid2) / 2_000_000
  return Number.isFinite(areaMm2) && areaMm2 > 0 ? areaMm2 : undefined
}
