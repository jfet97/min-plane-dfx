import { Data, Effect, Order } from 'effect'
import { performance } from 'node:perf_hooks'
import {
  area,
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
  type NfpIfpService as NfpIfpServiceShape,
  NfpIfpService
} from '../../irregular/services.js'
import {
  candidateContainedInIntrinsicGap,
  deriveCanonicalIntrinsicGapRegions,
  type CanonicalIntrinsicGapRegion
} from './intrinsicGapRegions.js'
import { intrinsicPreparedPieceClassKey } from './intrinsicReconstructionPortfolio.js'
import { IrregularBeamState } from './irregularBeamState.js'
import {
  IntrinsicStrictDecoderError,
  measureIntrinsicSheetlessCompletedLayout,
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
  readonly compactnessRank: number | undefined
  readonly fragmentationRank: number | undefined
  readonly voidRank: number | undefined
  readonly survivesAtTotalCapacities: Readonly<Record<'1' | '2' | '4' | '8' | '13', boolean>>
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
  }
  readonly steps: ReadonlyArray<IntrinsicQueueBeamStepReport>
}

export interface IntrinsicPartialGeometricBeamResult {
  readonly status: 'completed' | 'incomplete' | 'truncated'
  readonly experimentalWidth: number
  readonly truncationReason: 'maximum-runtime' | 'maximum-evaluations' | undefined
  readonly evaluations: number
  readonly runtimeMs: number
  readonly completedDepthCount: number
  readonly steps: ReadonlyArray<{
    readonly depth: number
    readonly parentCount: number
    readonly uniqueSuccessorCount: number
    readonly protectedControlKey: string | undefined
    readonly selectedSlots: IntrinsicPartialGeometricBeamSelection<IntrinsicPartialBeamEntry>['slots']
  }>
  readonly finalists: ReadonlyArray<{
    readonly futureEquivalenceKey: string
    readonly canonicalGeometryKey: string
    readonly metrics: IntrinsicStrictCompletedMetrics
    readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  }>
  readonly winner:
    | {
        readonly futureEquivalenceKey: string
        readonly canonicalGeometryKey: string
        readonly metrics: IntrinsicStrictCompletedMetrics
        readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
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
  readonly score: IntrinsicStrictLocalScore
  readonly movingCollisionAreaMm2: number
  readonly containingGap: CanonicalIntrinsicGapRegion | undefined
}

interface EnumeratedSuccessors {
  readonly generatedCandidateCount: number
  readonly scoredCandidateCount: number
  readonly canonicalLegalCandidateCount: number
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
        control
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
          control
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
        const capacities = [1, 2, 4, 8, 13] as const
        delayedLineage = {
          expectedCanonicalGeometryKey: expectedReferenceKey,
          generated: referenceCandidate !== undefined,
          paretoLayer: findCandidateLayer(referenceLayers, expectedReferenceKey),
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
          ) as Record<'1' | '2' | '4' | '8' | '13', boolean>
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
    const budget: AuditBudget = {
      startedAt,
      maximumRuntimeMs: input.maximumRuntimeMs,
      maximumEvaluations: Math.max(1, Math.floor(input.maximumEvaluations)),
      evaluations: 0,
      truncationReason: undefined
    }
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
                message: `partial geometric beam exceeded ${budget.maximumRuntimeMs} ms.`
              })
            )
          : Effect.void
    }
    const initialState = IrregularBeamState.empty(input.orderedPreparedPieces)
    let protectedControlState = initialState
    let experimentalStates: ReadonlyArray<IntrinsicPartialBeamEntry> = []
    const steps: IntrinsicPartialGeometricBeamResult['steps'][number][] = []

    for (let depth = 0; depth < input.orderedPreparedPieces.length; depth += 1) {
      if (auditRuntimeExpired(budget)) break
      const piece = input.orderedPreparedPieces[depth]
      if (piece === undefined) continue
      const remainingPreparedPieces = input.orderedPreparedPieces.slice(depth + 1)
      const parentStates = deduplicatePartialParents([
        protectedControlState,
        ...experimentalStates.map(({ state }) => state)
      ])
      const successors: AuditCandidate[] = []
      let protectedSuccessor: AuditCandidate | undefined
      for (const parentState of parentStates) {
        const outcome = yield* enumerateWithDeadlineRecovery({
          state: parentState,
          piece,
          remainingPreparedPieces,
          budget,
          settings,
          geometryKernel,
          nfpIfpService,
          candidateMemoScope,
          control
        })
        if (outcome === undefined || !outcome.fullyEnumerated) break
        successors.push(...outcome.uniqueCanonicalSuccessors)
        if (parentState === protectedControlState) {
          protectedSuccessor =
            outcome.uniqueCanonicalSuccessors.find(
              ({ canonicalGeometryKey }) =>
                canonicalGeometryKey === outcome.selected?.canonicalGeometryKey
            ) ?? orderCandidates(outcome.uniqueCanonicalSuccessors)[0]
        }
      }
      if (budget.truncationReason !== undefined) break
      if (protectedSuccessor === undefined) {
        protectedControlState = protectedControlState.withUnplacedPiece({
          remainingPreparedPieces,
          unplacedPieceId: preparedPieceId(piece)
        })
      } else {
        protectedControlState = protectedSuccessor.state
      }
      const entries = successors
        .filter(({ state }) => partialStateCanFit(state, input.finalSheet))
        .map(partialBeamEntry)
      const protectedEntry =
        protectedSuccessor === undefined || !partialStateCanFit(protectedSuccessor.state, input.finalSheet)
          ? undefined
          : partialBeamEntry(protectedSuccessor)
      const selection = selectIntrinsicPartialGeometricBeam({
        candidates: entries,
        experimentalWidth,
        ...(protectedEntry === undefined ? {} : { protectedControl: protectedEntry })
      })
      experimentalStates = selection.retained
      steps.push({
        depth,
        parentCount: parentStates.length,
        uniqueSuccessorCount: new Set(entries.map(({ futureEquivalenceKey }) => futureEquivalenceKey))
          .size,
        protectedControlKey: protectedEntry?.futureEquivalenceKey,
        selectedSlots: selection.slots
      })
    }

    const completeEntries = deduplicatePartialEntries([
      ...(partialStateCanFit(protectedControlState, input.finalSheet)
        ? [partialEntryFromState(protectedControlState)]
        : []),
      ...experimentalStates
    ]).filter(
      ({ state }) =>
        state.remainingPreparedPieces.length === 0 && state.unplacedPieceIds.length === 0
    )
    const finalists = completeEntries.flatMap((entry) => {
      const measured = measureIntrinsicSheetlessCompletedLayout(
        entry.state,
        Math.max(0, performance.now() - startedAt)
      )
      return measured === undefined
        ? []
        : [
            {
              futureEquivalenceKey: entry.futureEquivalenceKey,
              canonicalGeometryKey: entry.canonicalGeometryKey,
              metrics: measured.metrics,
              placedCollisionGeometries: measured.placedCollisionGeometries
            }
          ]
    })
    const rankedMetrics = rankIntrinsicStrictCompletedLayouts(finalists.map(({ metrics }) => metrics))
    const winningHash = rankedMetrics[0]?.canonicalGeometryHash
    const winner = finalists.find(({ metrics }) => metrics.canonicalGeometryHash === winningHash)
    return {
      status:
        budget.truncationReason !== undefined
          ? 'truncated'
          : winner === undefined
            ? 'incomplete'
            : 'completed',
      experimentalWidth,
      truncationReason: budget.truncationReason,
      evaluations: budget.evaluations,
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
    futureEquivalenceKey: partialFutureEquivalenceKey(state),
    canonicalGeometryKey: state.canonicalOccupiedGeometryKey,
    axes,
    placedCollisionGeometries: state.placedCollisionGeometries
  }
}

function partialFutureEquivalenceKey(state: IrregularBeamState): string {
  return JSON.stringify({
    occupied: state.canonicalOccupiedGeometryKey,
    remaining: state.remainingPreparedPieces.map(intrinsicPreparedPieceClassKey),
    unplaced: [...state.unplacedPieceIds].toSorted()
  })
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
  Exclude<AuditError, IntrinsicQueueBeamDiscriminatorError>,
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
  Exclude<AuditError, IntrinsicQueueBeamDiscriminatorError>,
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
  Exclude<AuditError, IntrinsicQueueBeamDiscriminatorError>,
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
}

function enumerateSuccessors(
  input: EnumerationInput
): Effect.Effect<
  EnumeratedSuccessors,
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError
> {
  return Effect.gen(function* () {
    let generatedCandidateCount = 0
    let scoredCandidateCount = 0
    let canonicalLegalCandidateCount = 0
    const familyWinners = new Map<string, AuditCandidate>()
    const uniqueCanonicalSuccessors = new Map<string, AuditCandidate>()
    const gapRegions = deriveCanonicalIntrinsicGapRegions(input.state.placedCollisionGeometries)
    for (const transform of [...input.piece.transforms].sort(transformCandidateOrder)) {
      yield* input.control.checkpoint('candidate-points')
      const moving = yield* input.geometryKernel.transformCollisionGeometry({
        geometry: input.piece.collisionGeometry,
        transform
      })
      const movingCollisionAreaMm2 = canonicalCollisionAreaMm2(moving)
      if (movingCollisionAreaMm2 === undefined) continue
      const candidates =
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
      generatedCandidateCount += candidates.length
      for (const candidate of candidates) {
        if (!takeAuditEvaluation(input.budget)) {
          return {
            generatedCandidateCount,
            scoredCandidateCount,
            canonicalLegalCandidateCount,
            uniqueCanonicalSuccessors: [...uniqueCanonicalSuccessors.values()],
            selected: selectIntrinsicStrictFamilyWinner([...familyWinners.values()], 'pure-growth'),
            fullyEnumerated: false
          }
        }
        const scored = scoreAuditCandidate({ ...input, moving, candidate, gapRegions })
        if (scored === undefined) continue
        scoredCandidateCount += 1
        const familyWinner = familyWinners.get(scored.transformFamily)
        if (familyWinner === undefined || compareLocalScore(scored.score, familyWinner.score) < 0) {
          familyWinners.set(scored.transformFamily, scored)
        }
        if (!isCanonicalSheetlessStateLegal(scored.state)) continue
        canonicalLegalCandidateCount += 1
        const incumbent = uniqueCanonicalSuccessors.get(scored.canonicalGeometryKey)
        if (incumbent === undefined || compareCandidateIdentity(scored, incumbent) < 0) {
          uniqueCanonicalSuccessors.set(scored.canonicalGeometryKey, scored)
        }
      }
    }
    return {
      generatedCandidateCount,
      scoredCandidateCount,
      canonicalLegalCandidateCount,
      uniqueCanonicalSuccessors: [...uniqueCanonicalSuccessors.values()],
      selected: selectIntrinsicStrictFamilyWinner([...familyWinners.values()], 'pure-growth'),
      fullyEnumerated: true
    }
  })
}

function scoreAuditCandidate(
  input: EnumerationInput & {
    readonly moving: TransformedCollisionGeometry
    readonly candidate: IrregularPlacementCandidate
    readonly gapRegions: ReadonlyArray<CanonicalIntrinsicGapRegion> | undefined
  }
): AuditCandidate | undefined {
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
  const axes = measureIntrinsicQueueBeamAxes(state)
  const sharedBoundaryLengthMm = state.sharedCollisionBoundaryLengthMm
  const gridX = toGridMm(input.candidate.point.x)
  const gridY = toGridMm(input.candidate.point.y)
  if (
    envelope === undefined ||
    axes === undefined ||
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
    pieceId: preparedPieceId(input.piece),
    transformFamily: transformFamilyKey(input.candidate.transform),
    gridPoint: { x: gridX, y: gridY },
    canonicalGeometryKey: state.canonicalOccupiedGeometryKey,
    axes,
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
  readonly canonicalGeometryKey: string
  readonly axes: IntrinsicQueueBeamAxes
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
}

export interface IntrinsicPartialGeometricBeamSelection<T> {
  readonly retained: ReadonlyArray<T>
  readonly slots: ReadonlyArray<{
    readonly role: 'breadth' | 'contact' | 'dispersion'
    readonly layer: number
    readonly visit: number
    readonly futureEquivalenceKey: string
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
  const layers = partialNondominatedLayers(selectable)
  const breadth = Math.min(layers.length, Math.ceil(experimentalWidth / 2))
  const retained: T[] = []
  const slots: Array<IntrinsicPartialGeometricBeamSelection<T>['slots'][number]> = []
  const selectedKeys = new Set<string>()
  const visits = new Map<number, number>()
  const append = (candidate: T | undefined, role: 'breadth' | 'contact' | 'dispersion') => {
    if (candidate === undefined || selectedKeys.has(candidate.futureEquivalenceKey)) return false
    const layer = Math.max(
      0,
      layers.findIndex((members) => members.includes(candidate))
    )
    const visit = (visits.get(layer) ?? 0) + 1
    visits.set(layer, visit)
    selectedKeys.add(candidate.futureEquivalenceKey)
    retained.push(candidate)
    slots.push({ role, layer, visit, futureEquivalenceKey: candidate.futureEquivalenceKey })
    return true
  }

  for (let layerIndex = 0; layerIndex < breadth; layerIndex += 1) {
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
  while (remaining > 0 && breadth > 0) {
    let addedInCycle = false
    for (let layerIndex = breadth - 1; layerIndex >= 0 && remaining > 0; layerIndex -= 1) {
      const available = layers[layerIndex]?.filter(
        ({ futureEquivalenceKey }) => !selectedKeys.has(futureEquivalenceKey)
      )
      const next = selectMostDispersedCandidate(available ?? [], retainedForDistance())
      if (!append(next, 'dispersion')) continue
      remaining -= 1
      addedInCycle = true
    }
    if (!addedInCycle) break
  }

  return { retained, slots }
}

function partialNondominatedLayers<T extends IntrinsicPartialGeometricBeamCandidate>(
  candidates: ReadonlyArray<T>
): ReadonlyArray<ReadonlyArray<T>> {
  const remaining = new Map(
    candidates.map((candidate) => [candidate.futureEquivalenceKey, candidate] as const)
  )
  const layers: Array<ReadonlyArray<T>> = []
  while (remaining.size > 0) {
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
): T | undefined {
  return candidates.toSorted((first, second) => {
    const firstDistance = minimumOccupiedDistance(first, retained)
    const secondDistance = minimumOccupiedDistance(second, retained)
    return (
      compareOccupiedDistance(secondDistance, firstDistance) ||
      first.futureEquivalenceKey.localeCompare(second.futureEquivalenceKey)
    )
  })[0]
}

function minimumOccupiedDistance(
  candidate: IntrinsicPartialGeometricBeamCandidate,
  retained: ReadonlyArray<IntrinsicPartialGeometricBeamCandidate>
): IntrinsicOccupiedDistance {
  const distances = retained.map((member) => occupiedDistance(candidate, member))
  return distances.toSorted(compareOccupiedDistance)[0] ?? maximumOccupiedDistance()
}

function occupiedDistance(
  first: IntrinsicPartialGeometricBeamCandidate,
  second: IntrinsicPartialGeometricBeamCandidate
): IntrinsicOccupiedDistance {
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
  const ratio = ratios.toSorted(compareExactFraction)[0] ?? {
    numerator: 1n,
    denominator: 1n
  }
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

function maximumOccupiedDistance(): IntrinsicOccupiedDistance {
  return {
    voidHamming: Number.MAX_SAFE_INTEGER,
    contactHamming: Number.MAX_SAFE_INTEGER,
    symmetricDifferenceNumerator: 1n,
    pairUnionDenominator: 1n
  }
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
  const numerator = pathsDoubledArea(symmetricDifference)
  const denominator = pathsDoubledArea(pairUnion)
  if (denominator <= 0n) return undefined
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

function pathsDoubledArea(paths: ReadonlyArray<Path64>): bigint {
  const doubled = paths.reduce((sum, path) => sum + Math.round(area(path) * 2), 0)
  return BigInt(Math.abs(doubled))
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
  return {
    provided,
    matchedDepthCount: reports.filter(({ generated }) => generated).length,
    firstMissingDepth,
    minimumObservedSurvivalCapacity
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

function compareCandidateIdentity(first: AuditCandidate, second: AuditCandidate): number {
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
