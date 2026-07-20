import { Data, Effect, Order } from 'effect'
import { performance } from 'node:perf_hooks'
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
  measureCanonicalLayoutEnvelope,
  measureCanonicalLayoutTopologyExact
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
  measureIntrinsicStrictCanonicalEnvelope,
  selectIntrinsicStrictFamilyWinner,
  type IntrinsicStrictLocalScore
} from './intrinsicStrictDecoder.js'

const INTRINSIC_COORDINATE_DOMAIN = new SheetSpec({
  width: 1,
  height: 1,
  label: 'intrinsic-queue-beam-audit-coordinate-domain'
})

const SAME_PIECE_FRONTIER_CONTINUATION_LIMIT = 4
const DEFAULT_WITNESS_LIMIT = 4

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
    readonly selectedRanks: Omit<
      IntrinsicQueueBeamRankedWitness,
      'pieceId' | 'transformFamily' | 'gridPoint' | 'canonicalGeometryKey' | 'axes'
    > | undefined
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
  readonly steps: ReadonlyArray<IntrinsicQueueBeamStepReport>
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
    const steps: IntrinsicQueueBeamStepReport[] = []
    let truncationDepth = 0

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
        (candidate) =>
          assessIntrinsicQueueCandidate(candidate, scheduledSuccessors).paretoHeadroom
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
        if (selectedContinuationOutcome === undefined || !selectedContinuationOutcome.fullyEnumerated) {
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

      const classification = classifyIntrinsicQueueBeamHeadroom(
        bestQueueOpportunity !== undefined,
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
              : compareFragmentation(
                    bestQueueOpportunity.axes,
                    scheduledOutcome.selected.axes
                  ) > 0
        },
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
      steps
    }
  })
}

function enumerateWithDeadlineRecovery(input: EnumerationInput): Effect.Effect<
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

function enumerateSuccessors(input: EnumerationInput): Effect.Effect<
  EnumeratedSuccessors,
  IrregularNestingNotImplementedError | IrregularGeometryInputError | IrregularNfpIfpControlAbortError
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
    ?.filter((region) => candidateContainedInIntrinsicGap(input.moving, input.candidate.point, region))
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
  if (structure === undefined || envelope === undefined || topology === undefined || cavities === undefined) {
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
  const occupiedHullWasteDoubledAreaGrid2 =
    topology.hullDoubledAreaGrid2 - occupiedDoubledAreaGrid2
  const axes: IntrinsicQueueBeamAxes = {
    compactness: {
      maximumSideGrid: Math.round(envelope.maximumSideMm * 1_000),
      envelopeAreaGrid2: Math.round(envelope.areaMm2 * 1_000_000),
      spanGrid: Math.round(envelope.spanMm * 1_000)
    },
    fragmentation: {
      occupiedDoubledAreaOutsideLargestComponentGrid2: Math.round(
        occupiedAreaOutsideLargest * 2
      ),
      isolatedPieceCount: topology.topology.isolatedPieceCount,
      positiveContactComponentCount: topology.topology.positiveContactComponentCount,
      negativeLargestPositiveContactComponentSize:
        -topology.topology.largestPositiveContactComponentSize
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
  const comparisons = [
    compareCompactness(first, second),
    compareVoids(first, second)
  ]
  return comparisons.every((comparison) => comparison <= 0) &&
    comparisons.some((comparison) => comparison < 0)
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
  selected:
    | Pick<IntrinsicQueueBeamCandidateWitness, 'canonicalGeometryKey' | 'axes'>
    | undefined
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

function nondominatedFrontier(candidates: ReadonlyArray<AuditCandidate>): ReadonlyArray<AuditCandidate> {
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

function compareFragmentation(first: IntrinsicQueueBeamAxes, second: IntrinsicQueueBeamAxes): number {
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
    first.voids.occupiedHullWasteDoubledAreaGrid2 -
      second.voids.occupiedHullWasteDoubledAreaGrid2
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
    if (incumbent === undefined || preparedPieceId(piece).localeCompare(preparedPieceId(incumbent)) < 0) {
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

function compareLocalScore(first: IntrinsicStrictLocalScore, second: IntrinsicStrictLocalScore): number {
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
    if (firstX === undefined || firstY === undefined || secondX === undefined || secondY === undefined) {
      return undefined
    }
    doubledAreaGrid2 += firstX * secondY - secondX * firstY
  }
  const areaMm2 = Math.abs(doubledAreaGrid2) / 2_000_000
  return Number.isFinite(areaMm2) && areaMm2 > 0 ? areaMm2 : undefined
}

