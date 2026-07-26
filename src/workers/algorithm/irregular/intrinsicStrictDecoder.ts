import { Data, Effect, Order } from 'effect'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  type IrregularNestingSettings,
  IrregularPreparedPiece,
  IrregularTransform,
  IrregularTransformCandidate,
  type TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  analyzeCanonicalLayoutStructure,
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalEnclosedCavities,
  measureCanonicalLayoutContacts,
  measureCanonicalLayoutEnvelope,
  measureCanonicalLayoutTopologyExact
} from '../../irregular/canonicalLayoutGeometry.js'
import { fromGrid, toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
  IrregularNfpIfpCandidateMemoScope,
  type IrregularNfpIfpControl,
  IrregularNfpIfpControlAbortError,
  IrregularNestingNotImplementedError,
  type NfpIfpCandidateProvenance,
  NfpIfpService
} from '../../irregular/services.js'
import {
  IrregularBeamState,
  type IrregularBeamStatePlacementPhaseTimings
} from './irregularBeamState.js'
import {
  candidateContainedInIntrinsicGap,
  deriveCanonicalIntrinsicGapRegions,
  type CanonicalIntrinsicGapRegion
} from './intrinsicGapRegions.js'

/** Placeholder sheet for candidate generation in the deferred sheetless domain. */
export const INTRINSIC_COORDINATE_DOMAIN = new SheetSpec({
  width: 1,
  height: 1,
  label: 'intrinsic-sheetless-coordinate-domain'
})

export const transformCandidateOrder = Order.combineAll<IrregularTransformCandidate>([
  Order.mapInput(Order.Number, (transform) => transform.index),
  Order.mapInput(Order.Number, (transform) => transform.rotationDeg),
  Order.mapInput(Order.Boolean, (transform) => transform.mirrored),
  Order.mapInput(Order.String, (transform) => transform.reason)
])

export const INTRINSIC_STRICT_COHESION_FLOORS = {
  maximumEnclosedCavityCount: 2,
  maximumIsolatedPieceCount: 2,
  minimumLargestPositiveContactComponentRatio: 0.8,
  maximumLargestOccupiedHullGapRatio: 0.15
} as const

export class IntrinsicStrictDecoderError extends Data.TaggedError('IntrinsicStrictDecoderError')<{
  readonly operation: string
  readonly message: string
}> {}

export interface IntrinsicStrictStepTrace {
  readonly pieceId: PieceId
  readonly candidateCount: number
  readonly transformFamilyCount: number
  readonly selectedTransformFamily: string | undefined
  readonly selectedScore: IntrinsicStrictLocalScore | undefined
}

export interface IntrinsicStrictLocalScore {
  readonly maximumSideMm: number
  readonly envelopeAreaMm2: number
  readonly envelopeSpanMm: number
  readonly sharedBoundaryLengthMm: number
  readonly canonicalCombinedGeometryKey: string
  readonly exact?: {
    readonly maximumSideGrid: number
    readonly envelopeAreaGrid2: string
    readonly envelopeSpanGrid: number
  }
}

export type IntrinsicStrictComparatorMode =
  | 'pure-growth'
  | 'legacy-absolute-envelope'
  | 'contact-band'

export type IntrinsicStrictCandidateMode =
  | IntrinsicStrictComparatorMode
  | { readonly kind: 'gap-contained' }

export interface IntrinsicStrictFamilyWinner {
  readonly score: IntrinsicStrictLocalScore
  readonly movingCollisionAreaMm2: number
  readonly movingCollisionDoubledAreaGrid2?: string
}

export interface IntrinsicStrictCompletedMetrics {
  readonly envelopeMaximumSideMm: number
  readonly envelopeAreaMm2: number
  readonly envelopeSpanMm: number
  readonly enclosedCavityCount: number
  readonly totalEnclosedCavityAreaMm2: number
  readonly largestOccupiedHullGapRatio: number
  readonly isolatedPieceCount: number
  readonly positiveContactComponentCount: number
  readonly largestPositiveContactComponentSize: number
  readonly largestPositiveContactComponentRatio: number
  readonly occupiedAreaOutsideLargestContactComponentMm2: number
  readonly occupiedHullWasteRatio: number
  readonly totalStructuralContacts: number
  readonly dominantStructuralContacts: number
  readonly contactUnits: number
  readonly sharedBoundaryLengthMm: number
  readonly canonicalGeometryHash: string
  readonly runtimeMs: number
  /** Serializable exact grid terms used by production ranking and thresholds. */
  readonly exact?: {
    readonly envelopeMaximumSideGrid: number
    readonly envelopeAreaGrid2: string
    readonly envelopeSpanGrid: number
    readonly totalEnclosedCavityDoubledAreaGrid2: string
    readonly largestOccupiedHullGapDoubledAreaGrid2: string
    readonly occupiedHullDoubledAreaGrid2: string
    readonly occupiedHullWasteDoubledAreaGrid2: string
    readonly largestPositiveContactComponentSize: number
    readonly placedPieceCount: number
    readonly occupiedOutsideLargestContactComponentDoubledAreaGrid2: string
  }
}

export interface IntrinsicSheetlessCompletedLayout {
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly canonicalGeometryIdentity: string
  readonly canonicalGeometryHash: string
  readonly metrics: IntrinsicStrictCompletedMetrics
}

export interface IntrinsicStrictCertificate {
  readonly passes: boolean
  readonly violatedFloors: ReadonlyArray<keyof typeof INTRINSIC_STRICT_COHESION_FLOORS>
  readonly relativeDeficitSum: number
  readonly exactRelativeDeficitNumerator?: string
  readonly exactRelativeDeficitDenominator?: string
}

export interface IntrinsicStrictDecodeResult {
  readonly status: 'completed' | 'incomplete' | 'infeasible-final-sheet'
  readonly placements: ReadonlyArray<IrregularPlacement>
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly unplacedPieceIds: ReadonlyArray<PieceId>
  readonly terminalRotationDeg: 0 | 90 | undefined
  readonly canonicalGeometryHash: string | undefined
  readonly metrics: IntrinsicStrictCompletedMetrics | undefined
  readonly certificate: IntrinsicStrictCertificate | undefined
  readonly stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>
  readonly runtimeMs: number
}

export interface IntrinsicStrictConstructResult {
  readonly state: IrregularBeamState
  readonly stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>
  readonly gapFillEvidence: ReadonlyArray<IntrinsicStrictGapFillEvidence>
  readonly candidateEvaluationCount?: number
  readonly truncationReason?: 'maximum-candidate-evaluations'
  readonly pauseReason?: 'completed-piece-boundary'
  readonly checkpoint?: IntrinsicStrictDirectCheckpoint
  readonly phaseTimings?: IntrinsicStrictConstructPhaseTimings
  readonly runtimeMs: number
}

export const INTRINSIC_STRICT_DIRECT_CHECKPOINT_VERSION =
  'intrinsic-strict-direct-checkpoint-v1' as const

export interface IntrinsicStrictDirectCheckpoint {
  readonly version: typeof INTRINSIC_STRICT_DIRECT_CHECKPOINT_VERSION
  readonly producerRole: string
  readonly requestFingerprint: string
  readonly integrityHash: string
  readonly state: IrregularBeamState
  readonly nextPieceIndex: number
  readonly stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>
  readonly gapFillEvidence: ReadonlyArray<IntrinsicStrictGapFillEvidence>
  readonly candidateEvaluationCount: number
  readonly activeRuntimeMs: number
  readonly phaseLedger: IntrinsicStrictDirectPhaseLedger | undefined
}

interface IntrinsicStrictDirectPhaseLedger {
  readonly candidateGenerationMs: number
  readonly candidateStateScoringMs: number
  readonly candidateState: MutableCandidateStatePhaseTimings
}

export interface IntrinsicStrictConstructPhaseTimings {
  readonly candidateGenerationMs: number
  readonly candidateStateScoringMs: number
  readonly candidateStateScoring: IntrinsicStrictCandidateStatePhaseTimings
  readonly bookkeepingMs: number
  readonly coverageComplete: boolean
  readonly totalMs: number
}

export interface IntrinsicStrictCandidateStatePhaseTimings {
  readonly placementObjectMs: number
  readonly statePlacementMs: number
  readonly statePlacement: IrregularBeamStatePlacementPhaseTimings
  readonly bottomLeftAnchoringMs: number
  readonly envelopeScoringMs: number
  readonly gapClassificationMs: number
  readonly scoreBookkeepingMs: number
  readonly candidateSelectionMs: number
  readonly bookkeepingMs: number
  readonly coverageComplete: boolean
  readonly totalMs: number
}

export interface IntrinsicStrictGapFillEvidence {
  readonly pieceId: PieceId
  readonly regionKey: string
  readonly regionAreaBeforeMm2: number
  readonly regionAreaAfterMm2: number
  readonly envelopeMaximumSideDeltaMm: number
  readonly envelopeAreaDeltaMm2: number
  readonly sharedBoundaryLengthMm: number
  readonly nonInert: boolean
}

/** Observer-only F0 trace records. They are emitted before scoring changes no behavior. */
export interface IntrinsicStrictFeatureContactObserver {
  readonly onCandidateProvenance: (observation: {
    readonly step: number
    readonly parentStateId: string
    readonly pieceId: PieceId
    readonly transform: IrregularTransformCandidate
    readonly provenance: NfpIfpCandidateProvenance
    readonly gapCoverage: {
      readonly enclosedRegionCount: number
      readonly hullOpenRegionCount: number
      readonly directLegalInEnclosedCavity: number
      readonly directLegalInHullOpenGap: number
      readonly canonicalLegalInEnclosedCavity: number
      readonly canonicalLegalInHullOpenGap: number
    }
  }) => void
  readonly onStepSelection: (observation: {
    readonly step: number
    readonly parentStateId: string
    readonly pieceId: PieceId
    readonly selectedTransform: IrregularTransformCandidate | undefined
    readonly selectedGridPoint: { readonly gridX: number; readonly gridY: number } | undefined
    readonly selectedGap:
      | {
          readonly kind: CanonicalIntrinsicGapRegion['kind']
          readonly canonicalKey: string
          readonly areaMm2: number
        }
      | undefined
  }) => void
}

export interface ConstructIntrinsicStrictStateInput {
  readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly frozenPlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly candidateMode: IntrinsicStrictCandidateMode
  readonly maximumRuntimeMs?: number
  readonly maximumCandidateEvaluationCount?: number
  readonly captureCandidateEvaluationCount?: boolean
  readonly capturePhaseTimings?: boolean
  readonly producerRole?: string
  readonly checkpoint?: IntrinsicStrictDirectCheckpoint
  readonly maximumCompletedPieceBoundaries?: number
  readonly featureContactObserver?: IntrinsicStrictFeatureContactObserver
  readonly control?: IrregularNfpIfpControl
}

interface ScoredCandidate {
  readonly state: IrregularBeamState
  readonly score: IntrinsicStrictLocalScore
  readonly transformFamily: string
  readonly candidate: IrregularPlacementCandidate
  readonly movingCollisionAreaMm2: number
  readonly movingCollisionDoubledAreaGrid2: string
  readonly containingGap: CanonicalIntrinsicGapRegion | undefined
}

interface MutableCandidateStatePhaseTimings {
  placementObjectMs: number
  statePlacementMs: number
  statePlacementCanonicalEntryKeyMs: number
  statePlacementSpatialIndexMs: number
  statePlacementContactMeasurementMs: number
  statePlacementStateAssemblyMs: number
  statePlacementBookkeepingMs: number
  bottomLeftAnchoringMs: number
  envelopeScoringMs: number
  gapClassificationMs: number
  candidateSelectionMs: number
  totalMs: number
}

export function measureIntrinsicStrictCanonicalEnvelope(
  placed: ReadonlyArray<IrregularPlacedPiece>
):
  | Pick<IntrinsicStrictLocalScore, 'maximumSideMm' | 'envelopeAreaMm2' | 'envelopeSpanMm'>
  | undefined {
  const envelope = measureCanonicalLayoutEnvelope(placed)
  return envelope === undefined
    ? undefined
    : {
        maximumSideMm: envelope.maximumSideMm,
        envelopeAreaMm2: envelope.areaMm2,
        envelopeSpanMm: envelope.spanMm
      }
}

/** One strict, sheet-independent constructive decode followed by real-sheet legality. */
export function decodeIntrinsicStrictPriorityOrder(
  finalSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  options: {
    readonly maximumRuntimeMs?: number
    readonly comparatorMode?: IntrinsicStrictComparatorMode
  } = {}
): Effect.Effect<
  IntrinsicStrictDecodeResult,
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const maximumRuntimeMs = options.maximumRuntimeMs ?? 120_000
    const comparatorMode = options.comparatorMode ?? 'pure-growth'
    const constructed = yield* constructIntrinsicStrictState({
      allPreparedPieces: pieces,
      remainingPreparedPieces: pieces,
      frozenPlaced: [],
      candidateMode: comparatorMode,
      maximumRuntimeMs
    })
    return yield* finalizeIntrinsicStrictState(
      finalSheet,
      constructed,
      Math.max(0, performance.now() - startedAt)
    )
  })
}

/** Applies only terminal q0/q90 real-sheet legality to one sheetless constructed state. */
export function finalizeIntrinsicStrictState(
  finalSheet: SheetSpec,
  constructed: IntrinsicStrictConstructResult,
  runtimeMs = constructed.runtimeMs
): Effect.Effect<IntrinsicStrictDecodeResult, IntrinsicStrictDecoderError> {
  const state = constructed.state
  const stepTrace = constructed.stepTrace
  if (state.unplacedPieceIds.length > 0) {
    return Effect.succeed(makeResult({ status: 'incomplete', state, stepTrace, runtimeMs }))
  }
  const terminal = selectTerminalOrientation(state, finalSheet)
  if (terminal === undefined) {
    return Effect.succeed(
      makeResult({ status: 'infeasible-final-sheet', state, stepTrace, runtimeMs })
    )
  }
  const measured = measureIntrinsicSheetlessCompletedLayout(terminal.state, runtimeMs)
  if (measured === undefined) {
    return Effect.fail(
      new IntrinsicStrictDecoderError({
        operation: 'completedMetrics',
        message: 'completed canonical layout metrics must remain finite and exact.'
      })
    )
  }
  return Effect.succeed({
    ...makeResult({ status: 'completed', state: terminal.state, stepTrace, runtimeMs }),
    terminalRotationDeg: terminal.rotationDeg,
    canonicalGeometryHash: terminal.canonicalHash,
    metrics: measured.metrics,
    certificate: evaluateIntrinsicStrictCertificate(measured.metrics)
  })
}

/** Builds one exact sheetless E1 state from an optional real frozen seed. */
export function constructIntrinsicStrictState(
  input: ConstructIntrinsicStrictStateInput
): Effect.Effect<
  IntrinsicStrictConstructResult,
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const settings = yield* GeometrySettings
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const maximumRuntimeMs = input.maximumRuntimeMs ?? 120_000
    const maximumCandidateEvaluationCount =
      input.maximumCandidateEvaluationCount === undefined
        ? undefined
        : Math.max(1, Math.floor(input.maximumCandidateEvaluationCount))
    const maximumCompletedPieceBoundaries =
      input.maximumCompletedPieceBoundaries === undefined
        ? undefined
        : Math.max(1, Math.floor(input.maximumCompletedPieceBoundaries))
    const captureCandidateEvaluationCount =
      input.captureCandidateEvaluationCount === true ||
      maximumCandidateEvaluationCount !== undefined ||
      maximumCompletedPieceBoundaries !== undefined ||
      input.checkpoint !== undefined
    const checkpointingEnabled =
      maximumCompletedPieceBoundaries !== undefined || input.checkpoint !== undefined
    const capturePhaseTimings = input.capturePhaseTimings === true
    const partition = validateSeedPartition(input)
    if (partition !== undefined) {
      return yield* Effect.fail(
        new IntrinsicStrictDecoderError({ operation: 'seedPartition', message: partition })
      )
    }
    const producerRole = input.producerRole ?? 'intrinsic-strict'
    const requestFingerprint = checkpointingEnabled
      ? intrinsicStrictDirectRequestFingerprint({
          allPreparedPieces: input.allPreparedPieces,
          remainingPreparedPieces: input.remainingPreparedPieces,
          frozenPlaced: input.frozenPlaced,
          candidateMode: input.candidateMode,
          settings,
          producerRole,
          maximumRuntimeMs,
          maximumCandidateEvaluationCount,
          capturePhaseTimings
        })
      : undefined
    const checkpointError = validateIntrinsicStrictDirectCheckpoint({
      checkpoint: input.checkpoint,
      ...(requestFingerprint === undefined ? {} : { requestFingerprint }),
      producerRole,
      remainingPreparedPieces: input.remainingPreparedPieces,
      frozenPlaced: input.frozenPlaced,
      capturePhaseTimings
    })
    if (checkpointError !== undefined) {
      return yield* Effect.fail(
        new IntrinsicStrictDecoderError({
          operation: 'directCheckpoint',
          message: checkpointError
        })
      )
    }
    const previousActiveRuntimeMs = input.checkpoint?.activeRuntimeMs ?? 0
    const candidateMemoScope = new IrregularNfpIfpCandidateMemoScope()
    // Every caller constructs this checkpoint and runs it immediately, so the
    // deadline read happens at the same point an `Effect.gen` body would reach
    // it. Returning a shared `Effect.void` instead avoids one generator per
    // checkpoint, and the strict decode reaches this millions of times.
    const strictDeadlineReached = (): Effect.Effect<void, IrregularNfpIfpControlAbortError> =>
      previousActiveRuntimeMs + performance.now() - startedAt >= maximumRuntimeMs
        ? Effect.fail(
            new IrregularNfpIfpControlAbortError({
              reason: 'deadline',
              message: `intrinsic strict decode exceeded ${maximumRuntimeMs} ms.`
            })
          )
        : Effect.void
    const upstreamControl = input.control
    const control: IrregularNfpIfpControl =
      upstreamControl === undefined
        ? { checkpoint: () => strictDeadlineReached() }
        : {
            checkpoint: (phase) =>
              Effect.flatMap(upstreamControl.checkpoint(phase), strictDeadlineReached)
          }
    let state =
      input.checkpoint?.state ??
      new IrregularBeamState({
        remainingPreparedPieces: input.remainingPreparedPieces,
        placedCollisionGeometries: input.frozenPlaced,
        placementOrder: input.frozenPlaced.map(placedPieceId)
      }).withBottomLeftAnchored()
    if (
      state === undefined ||
      (state.placedCollisionGeometries.length > 0 &&
        !assertCanonicalGridLegalLayout(
          intrinsicBoundsSheet(state),
          state.placedCollisionGeometries
        ))
    ) {
      return yield* Effect.fail(
        new IntrinsicStrictDecoderError({
          operation: 'frozenPlaced',
          message: 'frozen seed placements must form one exact canonical sheetless layout.'
        })
      )
    }
    const stepTrace: IntrinsicStrictStepTrace[] = [
      ...(input.checkpoint?.stepTrace ?? [])
    ]
    const gapFillEvidence: IntrinsicStrictGapFillEvidence[] = [
      ...(input.checkpoint?.gapFillEvidence ?? [])
    ]
    let candidateEvaluationCount = input.checkpoint?.candidateEvaluationCount ?? 0
    let truncationReason: IntrinsicStrictConstructResult['truncationReason']
    let pauseReason: IntrinsicStrictConstructResult['pauseReason']
    let candidateGenerationMs =
      input.checkpoint?.phaseLedger?.candidateGenerationMs ?? 0
    let candidateStateScoringMs =
      input.checkpoint?.phaseLedger?.candidateStateScoringMs ?? 0
    const previousCandidateStatePhaseTimings =
      input.checkpoint?.phaseLedger?.candidateState
    const candidateStatePhaseTimings: MutableCandidateStatePhaseTimings = {
      placementObjectMs: previousCandidateStatePhaseTimings?.placementObjectMs ?? 0,
      statePlacementMs: previousCandidateStatePhaseTimings?.statePlacementMs ?? 0,
      statePlacementCanonicalEntryKeyMs:
        previousCandidateStatePhaseTimings?.statePlacementCanonicalEntryKeyMs ?? 0,
      statePlacementSpatialIndexMs:
        previousCandidateStatePhaseTimings?.statePlacementSpatialIndexMs ?? 0,
      statePlacementContactMeasurementMs:
        previousCandidateStatePhaseTimings?.statePlacementContactMeasurementMs ?? 0,
      statePlacementStateAssemblyMs:
        previousCandidateStatePhaseTimings?.statePlacementStateAssemblyMs ?? 0,
      statePlacementBookkeepingMs:
        previousCandidateStatePhaseTimings?.statePlacementBookkeepingMs ?? 0,
      bottomLeftAnchoringMs:
        previousCandidateStatePhaseTimings?.bottomLeftAnchoringMs ?? 0,
      envelopeScoringMs: previousCandidateStatePhaseTimings?.envelopeScoringMs ?? 0,
      gapClassificationMs:
        previousCandidateStatePhaseTimings?.gapClassificationMs ?? 0,
      candidateSelectionMs:
        previousCandidateStatePhaseTimings?.candidateSelectionMs ?? 0,
      totalMs: previousCandidateStatePhaseTimings?.totalMs ?? 0
    }
    let completedPieceBoundaries = 0
    const firstPieceIndex = input.checkpoint?.nextPieceIndex ?? 0

    pieceLoop: for (
      let pieceIndex = firstPieceIndex;
      pieceIndex < input.remainingPreparedPieces.length;
      pieceIndex += 1
    ) {
      const piece = input.remainingPreparedPieces[pieceIndex]
      if (piece === undefined) continue
      const pieceId = piece.pieceId ?? piece.source.id
      const parentStateId = state.canonicalOccupiedGeometryKey
      const remainingPreparedPieces = input.remainingPreparedPieces.slice(pieceIndex + 1)
      const candidatesByFamily = new Map<string, ScoredCandidate>()
      const containedCandidatesByFamily = new Map<
        string,
        ScoredCandidate & { containingGap: CanonicalIntrinsicGapRegion }
      >()
      const gapRegions =
        typeof input.candidateMode === 'object' || input.featureContactObserver !== undefined
          ? deriveCanonicalIntrinsicGapRegions(state.placedCollisionGeometries)
          : undefined
      let candidateCount = 0

      for (const transform of [...piece.transforms].sort(transformCandidateOrder)) {
        const candidateGenerationStartedAt = capturePhaseTimings ? performance.now() : 0
        let moving: TransformedCollisionGeometry
        let movingCollisionArea:
          | {
              readonly areaMm2: number
              readonly doubledAreaGrid2: string
            }
          | undefined
        let candidateProvenance: NfpIfpCandidateProvenance | undefined
        let legalCandidates: ReadonlyArray<IrregularPlacementCandidate> = []
        try {
          yield* control.checkpoint('candidate-points')
          moving = yield* geometryKernel.transformCollisionGeometry({
            geometry: piece.collisionGeometry,
            transform
          })
          movingCollisionArea = canonicalCollisionArea(moving)
          if (movingCollisionArea === undefined) continue
          legalCandidates =
            state.placedCollisionGeometries.length === 0
              ? originAnchorCandidates(moving)
              : yield* nfpIfpService.generatePlacementCandidates({
                  sheet: INTRINSIC_COORDINATE_DOMAIN,
                  placed: state.placedCollisionGeometries,
                  placedCollisionIndex: state.placedCollisionIndex,
                  moving,
                  settings,
                  candidateDomain: 'sheetless-nfp',
                  candidateMemoScope,
                  ...(input.featureContactObserver === undefined
                    ? {}
                    : {
                        onCandidateProvenance: (provenance: NfpIfpCandidateProvenance) => {
                          candidateProvenance = provenance
                        }
                      }),
                  control
                })
        } finally {
          if (capturePhaseTimings) {
            candidateGenerationMs += performance.now() - candidateGenerationStartedAt
          }
        }
        candidateCount += legalCandidates.length
        const family = transformFamilyKey(transform)
        const scoredCandidates: ScoredCandidate[] = []
        const candidateStateScoringStartedAt = capturePhaseTimings ? performance.now() : 0
        try {
          for (const candidate of legalCandidates) {
            if (
              maximumCandidateEvaluationCount !== undefined &&
              candidateEvaluationCount >= maximumCandidateEvaluationCount
            ) {
              truncationReason = 'maximum-candidate-evaluations'
              break pieceLoop
            }
            if (captureCandidateEvaluationCount) {
              candidateEvaluationCount += 1
            }
            const scored = scoreCandidate({
              state,
              piece,
              moving,
              candidate,
              remainingPreparedPieces,
              transformFamily: family,
              movingCollisionAreaMm2: movingCollisionArea.areaMm2,
              movingCollisionDoubledAreaGrid2:
                movingCollisionArea.doubledAreaGrid2,
              gapRegions,
              phaseTimings: capturePhaseTimings ? candidateStatePhaseTimings : undefined
            })
            if (scored === undefined) continue
            const candidateSelectionStartedAt = capturePhaseTimings ? performance.now() : 0
            scoredCandidates.push(scored)
            const incumbent = candidatesByFamily.get(family)
            if (incumbent === undefined || compareLocalScores(scored.score, incumbent.score) < 0) {
              candidatesByFamily.set(family, scored)
            }
            if (scored.containingGap !== undefined) {
              const containedScored = { ...scored, containingGap: scored.containingGap }
              const containedIncumbent = containedCandidatesByFamily.get(family)
              if (
                containedIncumbent === undefined ||
                compareGapContainedCandidates(containedScored, containedIncumbent) < 0
              ) {
                containedCandidatesByFamily.set(family, containedScored)
              }
            }
            if (capturePhaseTimings) {
              candidateStatePhaseTimings.candidateSelectionMs +=
                performance.now() - candidateSelectionStartedAt
            }
          }
        } finally {
          if (capturePhaseTimings) {
            candidateStateScoringMs += performance.now() - candidateStateScoringStartedAt
          }
        }
        if (candidateProvenance !== undefined) {
          const canonicalLegality = scoredCandidates.map((candidate) => ({
            candidate,
            legal: isCanonicalSheetlessStateLegal(candidate.state)
          }))
          input.featureContactObserver?.onCandidateProvenance({
            step: pieceIndex,
            parentStateId,
            pieceId,
            transform,
            provenance: {
              ...candidateProvenance,
              canonicalChecked: scoredCandidates.length,
              canonicalLegal: canonicalLegality.filter(({ legal }) => legal).length
            },
            gapCoverage: {
              enclosedRegionCount:
                gapRegions?.filter(({ kind }) => kind === 'enclosed-cavity').length ?? 0,
              hullOpenRegionCount:
                gapRegions?.filter(({ kind }) => kind === 'hull-open-gap').length ?? 0,
              directLegalInEnclosedCavity: scoredCandidates.filter(
                ({ containingGap }) => containingGap?.kind === 'enclosed-cavity'
              ).length,
              directLegalInHullOpenGap: scoredCandidates.filter(
                ({ containingGap }) => containingGap?.kind === 'hull-open-gap'
              ).length,
              canonicalLegalInEnclosedCavity: canonicalLegality.filter(
                ({ candidate, legal }) =>
                  legal && candidate.containingGap?.kind === 'enclosed-cavity'
              ).length,
              canonicalLegalInHullOpenGap: canonicalLegality.filter(
                ({ candidate, legal }) => legal && candidate.containingGap?.kind === 'hull-open-gap'
              ).length
            }
          })
        }
      }

      const familyWinners = [...candidatesByFamily.values()]
      const unanchoredSelected =
        typeof input.candidateMode === 'object'
          ? selectGapContainedWinner([...containedCandidatesByFamily.values(), ...familyWinners])
          : selectIntrinsicStrictFamilyWinner(familyWinners, input.candidateMode)
      const retainedStateAnchoringStartedAt = capturePhaseTimings ? performance.now() : 0
      const selectedState = unanchoredSelected?.state.withBottomLeftAnchored()
      if (capturePhaseTimings) {
        const retainedStateAnchoringMs = performance.now() - retainedStateAnchoringStartedAt
        candidateStateScoringMs += retainedStateAnchoringMs
        candidateStatePhaseTimings.bottomLeftAnchoringMs += retainedStateAnchoringMs
        candidateStatePhaseTimings.totalMs += retainedStateAnchoringMs
      }
      const selected =
        unanchoredSelected === undefined || selectedState === undefined
          ? undefined
          : { ...unanchoredSelected, state: selectedState }
      stepTrace.push({
        pieceId,
        candidateCount,
        transformFamilyCount: candidatesByFamily.size,
        selectedTransformFamily: selected?.transformFamily,
        selectedScore: selected?.score
      })
      const selectedGridX =
        selected === undefined ? undefined : toGridMm(selected.candidate.point.x)
      const selectedGridY =
        selected === undefined ? undefined : toGridMm(selected.candidate.point.y)
      input.featureContactObserver?.onStepSelection({
        step: pieceIndex,
        parentStateId,
        pieceId,
        selectedTransform: selected?.candidate.transform,
        selectedGridPoint:
          selectedGridX === undefined || selectedGridY === undefined
            ? undefined
            : { gridX: selectedGridX, gridY: selectedGridY },
        selectedGap:
          selected?.containingGap === undefined
            ? undefined
            : {
                kind: selected.containingGap.kind,
                canonicalKey: selected.containingGap.canonicalKey,
                areaMm2: selected.containingGap.areaMm2
              }
      })
      if (selected?.containingGap !== undefined) {
        const beforeBounds = state.translatedCollisionBounds
        const afterBounds = selected.state.translatedCollisionBounds
        const recomputedGapRegions = deriveCanonicalIntrinsicGapRegions(
          selected.state.placedCollisionGeometries
        )
        const totalGapAreaBeforeMm2 =
          gapRegions?.reduce((sum, region) => sum + region.areaMm2, 0) ?? Number.NaN
        const totalGapAreaAfterMm2 =
          recomputedGapRegions?.reduce((sum, region) => sum + region.areaMm2, 0) ?? Number.NaN
        const regionAreaAfterMm2 = Math.max(
          0,
          selected.containingGap.areaMm2 - (totalGapAreaBeforeMm2 - totalGapAreaAfterMm2)
        )
        const envelopeMaximumSideDeltaMm =
          beforeBounds === undefined || afterBounds === undefined
            ? Number.POSITIVE_INFINITY
            : Math.max(afterBounds.width, afterBounds.height) -
              Math.max(beforeBounds.width, beforeBounds.height)
        const envelopeAreaDeltaMm2 =
          beforeBounds === undefined || afterBounds === undefined
            ? Number.POSITIVE_INFINITY
            : afterBounds.width * afterBounds.height - beforeBounds.width * beforeBounds.height
        const beforeSharedBoundaryLengthMm = state.sharedCollisionBoundaryLengthMm ?? 0
        const afterSharedBoundaryLengthMm = selected.state.sharedCollisionBoundaryLengthMm ?? 0
        const insertedSharedBoundaryLengthMm =
          afterSharedBoundaryLengthMm >= beforeSharedBoundaryLengthMm
            ? afterSharedBoundaryLengthMm - beforeSharedBoundaryLengthMm
            : Number.NaN
        gapFillEvidence.push({
          pieceId,
          regionKey: selected.containingGap.canonicalKey,
          regionAreaBeforeMm2: selected.containingGap.areaMm2,
          regionAreaAfterMm2,
          envelopeMaximumSideDeltaMm,
          envelopeAreaDeltaMm2,
          sharedBoundaryLengthMm: insertedSharedBoundaryLengthMm,
          nonInert:
            insertedSharedBoundaryLengthMm > 0 &&
            envelopeMaximumSideDeltaMm === 0 &&
            envelopeAreaDeltaMm2 === 0 &&
            regionAreaAfterMm2 < selected.containingGap.areaMm2
        })
      }
      state =
        selected?.state ??
        state.withUnplacedPiece({
          remainingPreparedPieces,
          unplacedPieceId: pieceId
        })
      completedPieceBoundaries += 1
      if (
        maximumCompletedPieceBoundaries !== undefined &&
        completedPieceBoundaries >= maximumCompletedPieceBoundaries &&
        pieceIndex + 1 < input.remainingPreparedPieces.length
      ) {
        pauseReason = 'completed-piece-boundary'
        break
      }
    }

    const runtimeMs =
      previousActiveRuntimeMs + Math.max(0, performance.now() - startedAt)
    const nextPieceIndex = firstPieceIndex + completedPieceBoundaries
    const checkpoint =
      pauseReason === 'completed-piece-boundary' &&
      requestFingerprint !== undefined
        ? makeIntrinsicStrictDirectCheckpoint({
            producerRole,
            requestFingerprint,
            state,
            nextPieceIndex,
            stepTrace,
            gapFillEvidence,
            candidateEvaluationCount,
            activeRuntimeMs: runtimeMs,
            phaseLedger: capturePhaseTimings
              ? {
                  candidateGenerationMs,
                  candidateStateScoringMs,
                  candidateState: candidateStatePhaseTimings
                }
              : undefined
          })
        : undefined
    const phaseTimings = capturePhaseTimings
      ? makeConstructPhaseTimings(
          runtimeMs,
          candidateGenerationMs,
          candidateStateScoringMs,
          candidateStatePhaseTimings
        )
      : undefined
    return {
      state,
      stepTrace,
      gapFillEvidence,
      ...(pauseReason === undefined ? {} : { pauseReason }),
      ...(checkpoint === undefined ? {} : { checkpoint }),
      ...(!captureCandidateEvaluationCount
        ? {}
        : {
            candidateEvaluationCount,
            ...(truncationReason === undefined ? {} : { truncationReason })
          }),
      ...(phaseTimings === undefined ? {} : { phaseTimings }),
      runtimeMs
    }
  })
}

function makeIntrinsicStrictDirectCheckpoint(input: {
  readonly producerRole: string
  readonly requestFingerprint: string
  readonly state: IrregularBeamState
  readonly nextPieceIndex: number
  readonly stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>
  readonly gapFillEvidence: ReadonlyArray<IntrinsicStrictGapFillEvidence>
  readonly candidateEvaluationCount: number
  readonly activeRuntimeMs: number
  readonly phaseLedger: IntrinsicStrictDirectPhaseLedger | undefined
}): IntrinsicStrictDirectCheckpoint {
  const stateLineage = collectIntrinsicStrictDirectStateLineage(
    input.state,
    input.nextPieceIndex + 1
  )
  if (stateLineage === undefined) {
    throw new Error('committed direct checkpoint lineage is invalid.')
  }
  const checkpointWithoutIntegrity = {
    version: INTRINSIC_STRICT_DIRECT_CHECKPOINT_VERSION,
    producerRole: input.producerRole,
    requestFingerprint: input.requestFingerprint,
    state: input.state,
    nextPieceIndex: input.nextPieceIndex,
    stepTrace: [...input.stepTrace],
    gapFillEvidence: [...input.gapFillEvidence],
    candidateEvaluationCount: input.candidateEvaluationCount,
    activeRuntimeMs: input.activeRuntimeMs,
    phaseLedger: input.phaseLedger
  }
  return {
    ...checkpointWithoutIntegrity,
    integrityHash: intrinsicStrictDirectCheckpointIntegrityHash(
      checkpointWithoutIntegrity,
      stateLineage
    )
  }
}

function validateIntrinsicStrictDirectCheckpoint(input: {
  readonly checkpoint: IntrinsicStrictDirectCheckpoint | undefined
  readonly requestFingerprint?: string
  readonly producerRole: string
  readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly frozenPlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly capturePhaseTimings: boolean
}): string | undefined {
  const checkpoint = input.checkpoint
  if (checkpoint === undefined) return undefined
  if (input.requestFingerprint === undefined) {
    return 'direct checkpoint fingerprinting is not enabled.'
  }
  if (checkpoint.version !== INTRINSIC_STRICT_DIRECT_CHECKPOINT_VERSION) {
    return `unsupported direct checkpoint version ${checkpoint.version}.`
  }
  if (
    checkpoint.producerRole !== input.producerRole ||
    checkpoint.requestFingerprint !== input.requestFingerprint
  ) {
    return 'direct checkpoint producer or request fingerprint does not match.'
  }
  if (
    !Number.isSafeInteger(checkpoint.nextPieceIndex) ||
    checkpoint.nextPieceIndex <= 0 ||
    checkpoint.nextPieceIndex >= input.remainingPreparedPieces.length ||
    checkpoint.stepTrace.length !== checkpoint.nextPieceIndex ||
    checkpoint.state.remainingPreparedPieces.length !==
      input.remainingPreparedPieces.length - checkpoint.nextPieceIndex
  ) {
    return 'direct checkpoint is not positioned at a valid committed piece boundary.'
  }
  const stateLineage = collectIntrinsicStrictDirectStateLineage(
    checkpoint.state,
    checkpoint.nextPieceIndex + 1
  )
  if (stateLineage === undefined) {
    return 'direct checkpoint parent lineage is cyclic or has an invalid length.'
  }
  const expectedIntegrityHash = intrinsicStrictDirectCheckpointIntegrityHash(
    {
      version: checkpoint.version,
      producerRole: checkpoint.producerRole,
      requestFingerprint: checkpoint.requestFingerprint,
      state: checkpoint.state,
      nextPieceIndex: checkpoint.nextPieceIndex,
      stepTrace: checkpoint.stepTrace,
      gapFillEvidence: checkpoint.gapFillEvidence,
      candidateEvaluationCount: checkpoint.candidateEvaluationCount,
      activeRuntimeMs: checkpoint.activeRuntimeMs,
      phaseLedger: checkpoint.phaseLedger
    },
    stateLineage
  )
  if (checkpoint.integrityHash !== expectedIntegrityHash) {
    return 'direct checkpoint integrity hash does not match its retained state.'
  }
  const expectedPendingIds = input.remainingPreparedPieces
    .slice(checkpoint.nextPieceIndex)
    .map(preparedPieceId)
  const checkpointPendingIds =
    checkpoint.state.remainingPreparedPieces.map(preparedPieceId)
  if (
    expectedPendingIds.length !== checkpointPendingIds.length ||
    expectedPendingIds.some(
      (pieceId, index) => pieceId !== checkpointPendingIds[index]
    )
  ) {
    return 'direct checkpoint pending suffix does not match the prepared order.'
  }
  const lineageError = validateIntrinsicStrictDirectCheckpointLineage({
    checkpoint,
    remainingPreparedPieces: input.remainingPreparedPieces,
    frozenPlaced: input.frozenPlaced
  })
  if (lineageError !== undefined) return lineageError
  if (
    checkpoint.stepTrace.some(
      (trace, index) => {
        const preparedPiece = input.remainingPreparedPieces[index]
        return (
          preparedPiece === undefined ||
          trace.pieceId !== preparedPieceId(preparedPiece) ||
          !Number.isSafeInteger(trace.candidateCount) ||
          trace.candidateCount < 0
        )
      }
    )
  ) {
    return 'direct checkpoint trace does not match the consumed prepared prefix.'
  }
  const tracedCandidateEvaluations = checkpoint.stepTrace.reduce(
    (sum, trace) => sum + trace.candidateCount,
    0
  )
  if (
    !Number.isSafeInteger(checkpoint.candidateEvaluationCount) ||
    checkpoint.candidateEvaluationCount < 0 ||
    checkpoint.candidateEvaluationCount !== tracedCandidateEvaluations ||
    !Number.isFinite(checkpoint.activeRuntimeMs) ||
    checkpoint.activeRuntimeMs < 0
  ) {
    return 'direct checkpoint budget ledger is invalid.'
  }
  if (
    (checkpoint.phaseLedger !== undefined) !== input.capturePhaseTimings ||
    (checkpoint.phaseLedger !== undefined &&
      !intrinsicStrictDirectPhaseLedgerValid(checkpoint.phaseLedger))
  ) {
    return 'direct checkpoint phase-accounting policy or ledger is invalid.'
  }
  return undefined
}

function intrinsicStrictDirectRequestFingerprint(input: {
  readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly frozenPlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly candidateMode: IntrinsicStrictCandidateMode
  readonly settings: IrregularNestingSettings
  readonly producerRole: string
  readonly maximumRuntimeMs: number
  readonly maximumCandidateEvaluationCount: number | undefined
  readonly capturePhaseTimings: boolean
}): string {
  return createHash('sha256')
    .update(
      intrinsicStrictCanonicalJson({
        version: INTRINSIC_STRICT_DIRECT_CHECKPOINT_VERSION,
        producerRole: input.producerRole,
        candidateMode: input.candidateMode,
        settings: input.settings,
        settlement: {
          maximumRuntimeMs: input.maximumRuntimeMs,
          maximumCandidateEvaluationCount: input.maximumCandidateEvaluationCount,
          capturePhaseTimings: input.capturePhaseTimings
        },
        allPreparedPieces: input.allPreparedPieces.map((piece) => ({
          pieceId: preparedPieceId(piece),
          collisionGeometry: piece.collisionGeometry,
          transforms: piece.transforms
        })),
        remainingPreparedIds: input.remainingPreparedPieces.map(preparedPieceId),
        frozenPlacementOrder: input.frozenPlaced.map(placedPieceId),
        frozenGeometryIdentity:
          canonicalCollisionLayoutIdentity(input.frozenPlaced) ?? ''
      })
    )
    .digest('hex')
}

function intrinsicStrictDirectCheckpointIntegrityHash(
  checkpoint: Omit<IntrinsicStrictDirectCheckpoint, 'integrityHash'>,
  stateLineage: ReadonlyArray<Record<string, unknown>>
): string {
  return createHash('sha256')
    .update(
      intrinsicStrictCanonicalJson({
        version: checkpoint.version,
        producerRole: checkpoint.producerRole,
        requestFingerprint: checkpoint.requestFingerprint,
        stateLineage,
        nextPieceIndex: checkpoint.nextPieceIndex,
        stepTrace: checkpoint.stepTrace,
        gapFillEvidence: checkpoint.gapFillEvidence,
        candidateEvaluationCount: checkpoint.candidateEvaluationCount,
        activeRuntimeMs: checkpoint.activeRuntimeMs,
        phaseLedger: checkpoint.phaseLedger
      })
    )
    .digest('hex')
}

function collectIntrinsicStrictDirectStateLineage(
  state: IrregularBeamState,
  expectedStateCount: number
): ReadonlyArray<Record<string, unknown>> | undefined {
  const lineage: Array<Record<string, unknown>> = []
  const visited = new Set<IrregularBeamState>()
  let cursor: IrregularBeamState | undefined = state
  while (cursor !== undefined) {
    if (visited.has(cursor) || lineage.length >= expectedStateCount) return undefined
    visited.add(cursor)
    lineage.push({
      pendingIds: cursor.remainingPreparedPieces.map(preparedPieceId),
      placedIds: cursor.placedCollisionGeometries.map(placedPieceId),
      unplacedIds: cursor.unplacedPieceIds,
      placementOrder: cursor.placementOrder,
      canonicalGeometryIdentity:
        canonicalCollisionLayoutIdentity(cursor.placedCollisionGeometries) ?? '',
      canonicalOccupiedGeometryKey: cursor.canonicalOccupiedGeometryKey,
      translatedCollisionBounds: cursor.translatedCollisionBounds,
      sharedCollisionBoundaryLengthMm: cursor.sharedCollisionBoundaryLengthMm,
      sharedCollisionBoundaryContactUnits:
        cursor.sharedCollisionBoundaryContactUnits,
      nearCompleteStructuralContactCount:
        cursor.nearCompleteStructuralContactCount,
      dominantNearCompleteStructuralContactCount:
        cursor.dominantNearCompleteStructuralContactCount,
      continuationMetadataIdentity: cursor.continuationMetadataIdentity()
    })
    cursor = cursor.parent
  }
  return lineage.length === expectedStateCount ? lineage : undefined
}

function validateIntrinsicStrictDirectCheckpointLineage(input: {
  readonly checkpoint: IntrinsicStrictDirectCheckpoint
  readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly frozenPlaced: ReadonlyArray<IrregularPlacedPiece>
}): string | undefined {
  const preparedIds = input.remainingPreparedPieces.map(preparedPieceId)
  const frozenIds = input.frozenPlaced.map(placedPieceId)
  let state: IrregularBeamState | undefined = input.checkpoint.state

  for (let depth = input.checkpoint.nextPieceIndex; depth > 0; depth -= 1) {
    if (state === undefined) {
      return 'direct checkpoint parent lineage ends before the consumed prefix.'
    }
    const stateError = validateIntrinsicStrictDirectState(state)
    if (stateError !== undefined) return stateError
    if (!samePieceIds(state.remainingPreparedPieces.map(preparedPieceId), preparedIds.slice(depth))) {
      return 'direct checkpoint lineage pending order does not match its depth.'
    }
    const expectedConsumedIds = [...frozenIds, ...preparedIds.slice(0, depth)]
    const accountedIds = [
      ...state.placedCollisionGeometries.map(placedPieceId),
      ...state.unplacedPieceIds
    ]
    if (!samePieceIdSet(accountedIds, expectedConsumedIds)) {
      return 'direct checkpoint state does not exactly account for the consumed prefix.'
    }
    const parent: IrregularBeamState | undefined = state.parent
    if (parent === undefined) {
      return 'direct checkpoint parent lineage ends before the consumed prefix.'
    }
    const pieceId = preparedIds[depth - 1]
    const placedDelta = state.placementOrder.length - parent.placementOrder.length
    const unplacedDelta = state.unplacedPieceIds.length - parent.unplacedPieceIds.length
    const placedTransition =
      placedDelta === 1 &&
      unplacedDelta === 0 &&
      state.placementOrder[state.placementOrder.length - 1] === pieceId
    const unplacedTransition =
      placedDelta === 0 &&
      unplacedDelta === 1 &&
      state.unplacedPieceIds[state.unplacedPieceIds.length - 1] === pieceId
    if (!placedTransition && !unplacedTransition) {
      return 'direct checkpoint parent lineage has an invalid consumed-piece transition.'
    }
    state = parent
  }

  if (state === undefined) {
    return 'direct checkpoint parent lineage has no frozen-seed root.'
  }
  const rootError = validateIntrinsicStrictDirectState(state)
  if (rootError !== undefined) return rootError
  const anchoredFrozen = new IrregularBeamState({
    remainingPreparedPieces: input.remainingPreparedPieces,
    placedCollisionGeometries: input.frozenPlaced,
    placementOrder: frozenIds
  }).withBottomLeftAnchored()
  if (
    anchoredFrozen === undefined ||
    state.parent !== undefined ||
    state.unplacedPieceIds.length !== 0 ||
    !samePieceIds(state.remainingPreparedPieces.map(preparedPieceId), preparedIds) ||
    !samePieceIds(state.placementOrder, frozenIds) ||
    state.canonicalOccupiedGeometryKey !== anchoredFrozen.canonicalOccupiedGeometryKey
  ) {
    return 'direct checkpoint parent lineage does not terminate at the frozen seed.'
  }
  return undefined
}

function validateIntrinsicStrictDirectState(state: IrregularBeamState): string | undefined {
  const placedIds = state.placedCollisionGeometries.map(placedPieceId)
  if (!samePieceIds(placedIds, state.placementOrder)) {
    return 'direct checkpoint placed geometry IDs do not match placement order.'
  }
  if (
    state.placedCollisionGeometries.length > 0 &&
    !assertCanonicalGridLegalLayout(
      intrinsicBoundsSheet(state),
      state.placedCollisionGeometries
    )
  ) {
    return 'direct checkpoint lineage contains a non-canonical layout.'
  }
  const recomputed = new IrregularBeamState({
    remainingPreparedPieces: state.remainingPreparedPieces,
    placedCollisionGeometries: state.placedCollisionGeometries,
    unplacedPieceIds: state.unplacedPieceIds,
    placementOrder: state.placementOrder,
    ...(state.parent === undefined ? {} : { parent: state.parent })
  })
  if (recomputed.canonicalOccupiedGeometryKey !== state.canonicalOccupiedGeometryKey) {
    return 'direct checkpoint canonical occupied identity is inconsistent.'
  }
  if (
    recomputed.canonicalEntryContinuationIdentity() !==
    state.canonicalEntryContinuationIdentity()
  ) {
    return 'direct checkpoint canonical-entry cache is inconsistent.'
  }
  if (
    recomputed.placedCollisionIndex.continuationIdentity() !==
    state.placedCollisionIndex.continuationIdentity()
  ) {
    return 'direct checkpoint spatial-index cache is inconsistent.'
  }
  if (!state.placedCollisionIndex.matches(state.placedCollisionGeometries)) {
    return 'direct checkpoint spatial index does not own the placed geometry.'
  }
  return undefined
}

function intrinsicStrictDirectPhaseLedgerValid(
  ledger: IntrinsicStrictDirectPhaseLedger
): boolean {
  return [
    ledger.candidateGenerationMs,
    ledger.candidateStateScoringMs,
    ...Object.values(ledger.candidateState)
  ].every((value) => Number.isFinite(value) && value >= 0)
}

function samePieceIds(
  first: ReadonlyArray<PieceId>,
  second: ReadonlyArray<PieceId>
): boolean {
  return (
    first.length === second.length &&
    first.every((pieceId, index) => pieceId === second[index])
  )
}

function samePieceIdSet(
  first: ReadonlyArray<PieceId>,
  second: ReadonlyArray<PieceId>
): boolean {
  const firstSorted = first.toSorted()
  const secondSorted = second.toSorted()
  return (
    firstSorted.length === secondSorted.length &&
    firstSorted.every((pieceId, index) => pieceId === secondSorted[index])
  )
}

function intrinsicStrictCanonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(intrinsicStrictCanonicalJson).join(',')}]`
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].toSorted(([first], [second]) =>
      String(first).localeCompare(String(second))
    )
    return intrinsicStrictCanonicalJson(entries)
  }
  const fields = Object.entries(value)
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .toSorted(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
    .map(
      ([key, fieldValue]) =>
        `${JSON.stringify(key)}:${intrinsicStrictCanonicalJson(fieldValue)}`
    )
  return `{${fields.join(',')}}`
}

function makeConstructPhaseTimings(
  totalMs: number,
  candidateGenerationMs: number,
  candidateStateScoringMs: number,
  candidateState: MutableCandidateStatePhaseTimings
): IntrinsicStrictConstructPhaseTimings {
  const statePlacement = {
    canonicalEntryKeyMs: candidateState.statePlacementCanonicalEntryKeyMs,
    spatialIndexMs: candidateState.statePlacementSpatialIndexMs,
    contactMeasurementMs: candidateState.statePlacementContactMeasurementMs,
    stateAssemblyMs: candidateState.statePlacementStateAssemblyMs,
    bookkeepingMs: candidateState.statePlacementBookkeepingMs,
    totalMs: candidateState.statePlacementMs
  }
  const candidateStateMeasuredMs =
    candidateState.placementObjectMs +
    candidateState.statePlacementMs +
    candidateState.bottomLeftAnchoringMs +
    candidateState.envelopeScoringMs +
    candidateState.gapClassificationMs
  const scoreBookkeepingMs = Math.max(0, candidateState.totalMs - candidateStateMeasuredMs)
  const measuredCandidateStateScoringMs =
    candidateState.totalMs + candidateState.candidateSelectionMs
  const candidateStateBookkeepingMs = Math.max(
    0,
    candidateStateScoringMs - measuredCandidateStateScoringMs
  )
  const candidateStateScoring = {
    placementObjectMs: candidateState.placementObjectMs,
    statePlacementMs: candidateState.statePlacementMs,
    statePlacement,
    bottomLeftAnchoringMs: candidateState.bottomLeftAnchoringMs,
    envelopeScoringMs: candidateState.envelopeScoringMs,
    gapClassificationMs: candidateState.gapClassificationMs,
    scoreBookkeepingMs,
    candidateSelectionMs: candidateState.candidateSelectionMs,
    bookkeepingMs: candidateStateBookkeepingMs,
    coverageComplete: intrinsicStrictPhaseCoverageComplete(
      candidateStateScoringMs,
      candidateStateBookkeepingMs
    ),
    totalMs: candidateStateScoringMs
  }
  const measuredMs = candidateGenerationMs + candidateStateScoringMs
  const bookkeepingMs = Math.max(0, totalMs - measuredMs)
  const coverageComplete =
    [totalMs, candidateGenerationMs, candidateStateScoringMs, bookkeepingMs].every(
      (value) => Number.isFinite(value) && value >= 0
    ) && intrinsicStrictPhaseCoverageComplete(totalMs, bookkeepingMs)
  return {
    candidateGenerationMs,
    candidateStateScoringMs,
    candidateStateScoring,
    bookkeepingMs,
    coverageComplete,
    totalMs
  }
}

/**
 * Small measured instrumentation residual allowed above the normal ratio.
 *
 * The unclassified residual is dominated by the `performance.now()` calls the
 * instrumentation itself makes. Measured on the seeded-construction fixture it
 * is `0.030-0.048 ms`. The allowance is therefore capped at `0.05 ms` and at
 * five percent of the phase, so it cannot classify a mostly-unaccounted phase
 * as complete. The normal one-percent rule remains authoritative outside this
 * measured instrumentation-sized exception.
 */
export const INTRINSIC_STRICT_PHASE_INSTRUMENTATION_ALLOWANCE_MS = 0.05 as const
export const INTRINSIC_STRICT_PHASE_MAXIMUM_RELAXED_RESIDUAL_RATIO = 0.05 as const

export function intrinsicStrictPhaseCoverageComplete(
  totalMs: number,
  bookkeepingMs: number
): boolean {
  return (
    totalMs >= 0 &&
    bookkeepingMs >= 0 &&
    (bookkeepingMs <= totalMs * 0.01 ||
      (bookkeepingMs <= INTRINSIC_STRICT_PHASE_INSTRUMENTATION_ALLOWANCE_MS &&
        bookkeepingMs <=
          totalMs * INTRINSIC_STRICT_PHASE_MAXIMUM_RELAXED_RESIDUAL_RATIO))
  )
}

function validateSeedPartition(input: ConstructIntrinsicStrictStateInput): string | undefined {
  const allIds = input.allPreparedPieces.map(preparedPieceId)
  const remainingIds = input.remainingPreparedPieces.map(preparedPieceId)
  const frozenIds = input.frozenPlaced.map(placedPieceId)
  if (new Set(allIds).size !== allIds.length) return 'all prepared piece ids must be unique.'
  if (new Set(remainingIds).size !== remainingIds.length)
    return 'remaining piece ids must be unique.'
  if (new Set(frozenIds).size !== frozenIds.length) return 'frozen placement ids must be unique.'
  const partitionIds = [...remainingIds, ...frozenIds]
  if (new Set(partitionIds).size !== partitionIds.length) {
    return 'frozen and remaining piece ids must be disjoint.'
  }
  if (
    partitionIds.length !== allIds.length ||
    partitionIds.toSorted().some((id, index) => id !== allIds.toSorted()[index])
  ) {
    return 'frozen and remaining piece ids must exactly partition all prepared pieces.'
  }
  return undefined
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function placedPieceId(piece: IrregularPlacedPiece): PieceId {
  return piece.placement.pieceId ?? piece.placement.sourcePieceId
}

function scoreCandidate(input: {
  readonly state: IrregularBeamState
  readonly piece: IrregularPreparedPiece
  readonly moving: TransformedCollisionGeometry
  readonly candidate: IrregularPlacementCandidate
  readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly transformFamily: string
  readonly movingCollisionAreaMm2: number
  readonly movingCollisionDoubledAreaGrid2: string
  readonly gapRegions: ReadonlyArray<CanonicalIntrinsicGapRegion> | undefined
  readonly phaseTimings: MutableCandidateStatePhaseTimings | undefined
}): ScoredCandidate | undefined {
  const startedAt = input.phaseTimings === undefined ? 0 : performance.now()
  try {
    const placementStartedAt = input.phaseTimings === undefined ? 0 : performance.now()
    const placement = makePlacement(input.piece, input.candidate)
    const placed = new IrregularPlacedPiece({
      placement,
      collisionGeometry: input.moving
    })
    if (input.phaseTimings !== undefined) {
      input.phaseTimings.placementObjectMs += performance.now() - placementStartedAt
    }
    const statePlacementStartedAt = input.phaseTimings === undefined ? 0 : performance.now()
    const phaseTimings = input.phaseTimings
    const placedState = input.state.withPlacement({
      remainingPreparedPieces: input.remainingPreparedPieces,
      placedCollisionGeometry: placed,
      placementOrderPieceId: input.piece.pieceId ?? input.piece.source.id,
      ...(phaseTimings === undefined
        ? {}
        : {
            onPhaseTimings: (timings: IrregularBeamStatePlacementPhaseTimings) => {
              phaseTimings.statePlacementCanonicalEntryKeyMs += timings.canonicalEntryKeyMs
              phaseTimings.statePlacementSpatialIndexMs += timings.spatialIndexMs
              phaseTimings.statePlacementContactMeasurementMs += timings.contactMeasurementMs
              phaseTimings.statePlacementStateAssemblyMs += timings.stateAssemblyMs
              phaseTimings.statePlacementBookkeepingMs += timings.bookkeepingMs
            }
          })
    })
    if (input.phaseTimings !== undefined) {
      input.phaseTimings.statePlacementMs += performance.now() - statePlacementStartedAt
    }
    const anchoringStartedAt = input.phaseTimings === undefined ? 0 : performance.now()
    const canonicalCombinedGeometryKey =
      placedState.bottomLeftAnchoredCanonicalOccupiedGeometryKey()
    if (input.phaseTimings !== undefined) {
      input.phaseTimings.bottomLeftAnchoringMs += performance.now() - anchoringStartedAt
    }
    if (canonicalCombinedGeometryKey === undefined) return undefined
    const envelopeStartedAt = input.phaseTimings === undefined ? 0 : performance.now()
    const envelope = measureIntrinsicStrictEnvelopeFromState(placedState)
    if (input.phaseTimings !== undefined) {
      input.phaseTimings.envelopeScoringMs += performance.now() - envelopeStartedAt
    }
    if (envelope === undefined) return undefined
    const { maximumSideMm, envelopeAreaMm2, envelopeSpanMm } = envelope
    const sharedBoundaryLengthMm = placedState.sharedCollisionBoundaryLengthMm
    if (
      sharedBoundaryLengthMm === undefined ||
      ![maximumSideMm, envelopeAreaMm2, envelopeSpanMm, sharedBoundaryLengthMm].every(
        Number.isFinite
      )
    ) {
      return undefined
    }
    const gapStartedAt = input.phaseTimings === undefined ? 0 : performance.now()
    const containingGap = input.gapRegions
      ?.filter((region) =>
        candidateContainedInIntrinsicGap(input.moving, input.candidate.point, region)
      )
      .toSorted(
        (first, second) =>
          first.areaMm2 - second.areaMm2 || first.canonicalKey.localeCompare(second.canonicalKey)
      )[0]
    if (input.phaseTimings !== undefined) {
      input.phaseTimings.gapClassificationMs += performance.now() - gapStartedAt
    }
    return {
      state: placedState,
      transformFamily: input.transformFamily,
      candidate: input.candidate,
      movingCollisionAreaMm2: input.movingCollisionAreaMm2,
      movingCollisionDoubledAreaGrid2:
        input.movingCollisionDoubledAreaGrid2,
      containingGap,
      score: {
        maximumSideMm,
        envelopeAreaMm2,
        envelopeSpanMm,
        sharedBoundaryLengthMm,
        canonicalCombinedGeometryKey,
        ...(envelope.exact === undefined ? {} : { exact: envelope.exact })
      }
    }
  } finally {
    if (input.phaseTimings !== undefined) {
      input.phaseTimings.totalMs += performance.now() - startedAt
    }
  }
}

function measureIntrinsicStrictEnvelopeFromState(
  state: IrregularBeamState
): Pick<
  IntrinsicStrictLocalScore,
  'maximumSideMm' | 'envelopeAreaMm2' | 'envelopeSpanMm' | 'exact'
> | undefined {
  const bounds = state.translatedCollisionBounds
  if (bounds === undefined) return undefined
  const widthGrid = toGridMm(bounds.width)
  const heightGrid = toGridMm(bounds.height)
  if (widthGrid === undefined || heightGrid === undefined || widthGrid < 0 || heightGrid < 0) {
    return undefined
  }
  const widthMm = fromGrid(widthGrid)
  const heightMm = fromGrid(heightGrid)
  const metrics = {
    maximumSideMm: Math.max(widthMm, heightMm),
    envelopeAreaMm2: widthMm * heightMm,
    envelopeSpanMm: widthMm + heightMm,
    exact: {
      maximumSideGrid: Math.max(widthGrid, heightGrid),
      envelopeAreaGrid2: (BigInt(widthGrid) * BigInt(heightGrid)).toString(),
      envelopeSpanGrid: widthGrid + heightGrid
    }
  }
  return [
    metrics.maximumSideMm,
    metrics.envelopeAreaMm2,
    metrics.envelopeSpanMm,
    metrics.exact.maximumSideGrid,
    metrics.exact.envelopeSpanGrid
  ].every(Number.isFinite)
    ? metrics
    : undefined
}

function selectGapContainedWinner(
  candidates: ReadonlyArray<ScoredCandidate>
): ScoredCandidate | undefined {
  const contained = candidates
    .filter(
      (candidate): candidate is ScoredCandidate & { containingGap: CanonicalIntrinsicGapRegion } =>
        candidate.containingGap !== undefined
    )
    .toSorted(compareGapContainedCandidates)[0]
  return contained ?? selectIntrinsicStrictFamilyWinner(candidates, 'pure-growth')
}

function compareGapContainedCandidates(
  first: ScoredCandidate & { containingGap: CanonicalIntrinsicGapRegion },
  second: ScoredCandidate & { containingGap: CanonicalIntrinsicGapRegion }
): number {
  return (
    compareBigIntAscending(
      BigInt(first.containingGap.doubledAreaGrid2),
      BigInt(second.containingGap.doubledAreaGrid2)
    ) ||
    second.score.sharedBoundaryLengthMm - first.score.sharedBoundaryLengthMm ||
    compareLocalScores(first.score, second.score)
  )
}

/** Selects among pure-growth transform-family winners under the requested E1 mode. */
export function selectIntrinsicStrictFamilyWinner<T extends IntrinsicStrictFamilyWinner>(
  candidates: ReadonlyArray<T>,
  comparatorMode: IntrinsicStrictComparatorMode
): T | undefined {
  if (comparatorMode === 'legacy-absolute-envelope') {
    return candidates.toSorted(compareLegacyAbsoluteEnvelopeCandidates)[0]
  }
  const pureLeader = candidates.reduce<T | undefined>(
    (best, candidate) =>
      best === undefined || compareLocalScores(candidate.score, best.score) < 0 ? candidate : best,
    undefined
  )
  if (pureLeader === undefined || comparatorMode === 'pure-growth') return pureLeader

  return candidates
    .filter(
      (candidate) => {
        const candidateExact = candidate.score.exact
        const leaderExact = pureLeader.score.exact
        const movingDoubledArea =
          candidate.movingCollisionDoubledAreaGrid2
        if (
          candidateExact !== undefined &&
          leaderExact !== undefined &&
          movingDoubledArea !== undefined
        ) {
          return (
            candidateExact.maximumSideGrid ===
              leaderExact.maximumSideGrid &&
            100n * BigInt(candidateExact.envelopeAreaGrid2) <=
              100n * BigInt(leaderExact.envelopeAreaGrid2) +
                BigInt(movingDoubledArea)
          )
        }
        return (
          canonicalLinearMetric(candidate.score.maximumSideMm) ===
            canonicalLinearMetric(pureLeader.score.maximumSideMm) &&
          canonicalAreaMetric(candidate.score.envelopeAreaMm2) <=
            canonicalAreaMetric(
              pureLeader.score.envelopeAreaMm2 +
                0.02 * candidate.movingCollisionAreaMm2
            )
        )
      }
    )
    .toSorted(compareContactBandCandidates)[0]
}

/** Historical absolute-envelope role retained as an exact, sheet-free seed. */
function compareLegacyAbsoluteEnvelopeCandidates(
  first: IntrinsicStrictFamilyWinner,
  second: IntrinsicStrictFamilyWinner
): number {
  const exact = compareExactLocalEnvelopes(first.score, second.score, 'area-first')
  if (exact !== undefined && exact !== 0) return exact
  return (
    (exact ?? (
      canonicalAreaMetric(first.score.envelopeAreaMm2) -
        canonicalAreaMetric(second.score.envelopeAreaMm2) ||
      canonicalLinearMetric(first.score.maximumSideMm) -
        canonicalLinearMetric(second.score.maximumSideMm) ||
      canonicalLinearMetric(first.score.envelopeSpanMm) -
        canonicalLinearMetric(second.score.envelopeSpanMm)
    )) ||
    second.score.sharedBoundaryLengthMm - first.score.sharedBoundaryLengthMm ||
    first.score.canonicalCombinedGeometryKey.localeCompare(
      second.score.canonicalCombinedGeometryKey
    )
  )
}

function compareContactBandCandidates(
  first: IntrinsicStrictFamilyWinner,
  second: IntrinsicStrictFamilyWinner
): number {
  const exact = compareExactLocalEnvelopes(first.score, second.score, 'area-first')
  return (
    second.score.sharedBoundaryLengthMm - first.score.sharedBoundaryLengthMm ||
    (exact ?? (
      canonicalAreaMetric(first.score.envelopeAreaMm2) -
        canonicalAreaMetric(second.score.envelopeAreaMm2) ||
      canonicalLinearMetric(first.score.envelopeSpanMm) -
        canonicalLinearMetric(second.score.envelopeSpanMm)
    )) ||
    first.score.canonicalCombinedGeometryKey.localeCompare(
      second.score.canonicalCombinedGeometryKey
    )
  )
}

function compareLocalScores(
  first: IntrinsicStrictLocalScore,
  second: IntrinsicStrictLocalScore
): number {
  const exact = compareExactLocalEnvelopes(first, second, 'maximum-side-first')
  return (
    (exact ?? (
      canonicalLinearMetric(first.maximumSideMm) -
        canonicalLinearMetric(second.maximumSideMm) ||
      canonicalAreaMetric(first.envelopeAreaMm2) -
        canonicalAreaMetric(second.envelopeAreaMm2) ||
      canonicalLinearMetric(first.envelopeSpanMm) -
        canonicalLinearMetric(second.envelopeSpanMm)
    )) ||
    second.sharedBoundaryLengthMm - first.sharedBoundaryLengthMm ||
    first.canonicalCombinedGeometryKey.localeCompare(second.canonicalCombinedGeometryKey)
  )
}

function compareExactLocalEnvelopes(
  first: IntrinsicStrictLocalScore,
  second: IntrinsicStrictLocalScore,
  mode: 'maximum-side-first' | 'area-first'
): number | undefined {
  if (first.exact === undefined || second.exact === undefined) return undefined
  const areaComparison = compareBigIntAscending(
    BigInt(first.exact.envelopeAreaGrid2),
    BigInt(second.exact.envelopeAreaGrid2)
  )
  return mode === 'maximum-side-first'
    ? first.exact.maximumSideGrid - second.exact.maximumSideGrid ||
        areaComparison ||
        first.exact.envelopeSpanGrid - second.exact.envelopeSpanGrid
    : areaComparison ||
        first.exact.maximumSideGrid - second.exact.maximumSideGrid ||
        first.exact.envelopeSpanGrid - second.exact.envelopeSpanGrid
}

/** Canonicalizes one linear millimeter metric to the deterministic 0.001 mm grid. */
export function canonicalLinearMetric(valueMm: number): number {
  return Math.round(valueMm * 1_000)
}

/** Canonicalizes one square-millimeter metric to the deterministic 1e-6 mm2 grid. */
export function canonicalAreaMetric(valueMm2: number): number {
  return Math.round(valueMm2 * 1_000_000)
}

function canonicalCollisionArea(
  moving: TransformedCollisionGeometry
):
  | {
      readonly areaMm2: number
      readonly doubledAreaGrid2: string
    }
  | undefined {
  let doubledAreaGrid2 = 0n
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
    doubledAreaGrid2 +=
      BigInt(firstX) * BigInt(secondY) -
      BigInt(secondX) * BigInt(firstY)
  }
  const absoluteDoubledAreaGrid2 =
    doubledAreaGrid2 < 0n ? -doubledAreaGrid2 : doubledAreaGrid2
  const areaMm2 = Number(absoluteDoubledAreaGrid2) / 2_000_000
  return Number.isFinite(areaMm2) && areaMm2 > 0
    ? {
        areaMm2,
        doubledAreaGrid2: absoluteDoubledAreaGrid2.toString()
      }
    : undefined
}

/** Deterministic origin anchor for the first placement of an empty sheetless state. */
export function originAnchorCandidates(
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

function transformFamilyKey(transform: IrregularTransformCandidate): string {
  const remainder = transform.rotationDeg % 360
  const rotationDeg = remainder < 0 ? remainder + 360 : remainder
  return `${Object.is(rotationDeg, -0) ? 0 : rotationDeg}:${Number(transform.mirrored)}`
}

function makePlacement(
  piece: IrregularPreparedPiece,
  candidate: IrregularPlacementCandidate
): IrregularPlacement {
  const input = {
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
    ? new IrregularPlacement(input)
    : new IrregularPlacement({ ...input, pieceId: piece.pieceId })
}

function selectTerminalOrientation(
  state: IrregularBeamState,
  sheet: SheetSpec
):
  | {
      readonly state: IrregularBeamState
      readonly rotationDeg: 0 | 90
      readonly canonicalHash: string
    }
  | undefined {
  const legal: Array<{
    readonly state: IrregularBeamState
    readonly rotationDeg: 0 | 90
    readonly canonicalHash: string
  }> = []
  for (const rotationDeg of [0, 90] as const) {
    const oriented = state.withQuarterTurnBottomLeft(rotationDeg)
    if (
      oriented === undefined ||
      !assertCanonicalGridLegalLayout(sheet, oriented.placedCollisionGeometries)
    ) {
      continue
    }
    const canonicalIdentity = canonicalCollisionLayoutIdentity(oriented.placedCollisionGeometries)
    if (canonicalIdentity !== undefined) {
      legal.push({
        state: oriented,
        rotationDeg,
        canonicalHash: createHash('sha256').update(canonicalIdentity).digest('hex')
      })
    }
  }
  return legal.toSorted(
    (first, second) =>
      first.canonicalHash.localeCompare(second.canonicalHash) ||
      first.rotationDeg - second.rotationDeg
  )[0]
}

/** Measures one complete exact layout without consulting a requested sheet. */
export function measureIntrinsicSheetlessCompletedLayout(
  state: IrregularBeamState,
  runtimeMs = 0
): IntrinsicSheetlessCompletedLayout | undefined {
  const anchored = state.withBottomLeftAnchored()
  if (
    anchored === undefined ||
    anchored.unplacedPieceIds.length > 0 ||
    !assertCanonicalGridLegalLayout(
      intrinsicBoundsSheet(anchored),
      anchored.placedCollisionGeometries
    )
  ) {
    return undefined
  }
  const canonicalGeometryIdentity = canonicalCollisionLayoutIdentity(
    anchored.placedCollisionGeometries
  )
  if (canonicalGeometryIdentity === undefined) return undefined
  const canonicalGeometryHash = createHash('sha256').update(canonicalGeometryIdentity).digest('hex')
  const metrics = completedMetrics(anchored, canonicalGeometryHash, runtimeMs)
  return metrics === undefined
    ? undefined
    : {
        placedCollisionGeometries: anchored.placedCollisionGeometries,
        canonicalGeometryIdentity,
        canonicalGeometryHash,
        metrics
      }
}

function completedMetrics(
  state: IrregularBeamState,
  canonicalGeometryHash: string,
  runtimeMs: number
): IntrinsicStrictCompletedMetrics | undefined {
  const topologyExact = measureCanonicalLayoutTopologyExact(state.placedCollisionGeometries)
  const cavities = measureCanonicalEnclosedCavities(state.placedCollisionGeometries)
  const structure = analyzeCanonicalLayoutStructure(
    intrinsicBoundsSheet(state),
    state.placedCollisionGeometries
  )
  const contacts = measureCanonicalLayoutContacts(state.placedCollisionGeometries)
  const envelope = measureCanonicalLayoutEnvelope(state.placedCollisionGeometries)
  if (
    topologyExact === undefined ||
    cavities === undefined ||
    structure === undefined ||
    contacts === undefined ||
    envelope === undefined
  ) {
    return undefined
  }
  const topology = topologyExact.topology
  const largestComponent = new Set(structure.positiveContactComponents[0] ?? [])
  const occupiedOutsideLargestDoubledArea = structure.pieces.reduce(
    (sum, piece) =>
      sum +
      (largestComponent.has(piece.pieceId) ? 0n : BigInt(piece.doubledAreaGrid2)),
    0n
  )
  const occupiedAreaOutsideLargestContactComponentMm2 =
    Number(occupiedOutsideLargestDoubledArea) / 2_000_000
  const occupiedHullDoubledArea = BigInt(envelope.hullDoubledAreaGrid2)
  const occupiedDoubledArea = BigInt(envelope.occupiedDoubledAreaGrid2)
  const metrics = {
    envelopeMaximumSideMm: envelope.maximumSideMm,
    envelopeAreaMm2: envelope.areaMm2,
    envelopeSpanMm: envelope.spanMm,
    enclosedCavityCount: cavities.count,
    totalEnclosedCavityAreaMm2: cavities.totalAreaMm2,
    largestOccupiedHullGapRatio: topology.largestOccupiedHullGapRatio,
    isolatedPieceCount: topology.isolatedPieceCount,
    positiveContactComponentCount: topology.positiveContactComponentCount,
    largestPositiveContactComponentSize: topology.largestPositiveContactComponentSize,
    largestPositiveContactComponentRatio: topology.largestPositiveContactComponentRatio,
    occupiedAreaOutsideLargestContactComponentMm2,
    occupiedHullWasteRatio: envelope.occupiedHullWasteRatio,
    totalStructuralContacts: contacts.totalStructuralContacts,
    dominantStructuralContacts: contacts.dominantStructuralContacts,
    contactUnits: contacts.contactUnits,
    sharedBoundaryLengthMm: contacts.sharedBoundaryLengthMm,
    canonicalGeometryHash,
    runtimeMs,
    exact: {
      envelopeMaximumSideGrid: envelope.maximumSideGrid,
      envelopeAreaGrid2: envelope.envelopeAreaGrid2,
      envelopeSpanGrid: envelope.spanGrid,
      totalEnclosedCavityDoubledAreaGrid2: cavities.totalDoubledAreaGrid2,
      largestOccupiedHullGapDoubledAreaGrid2:
        topologyExact.exactHullGapDoubledAreaGrid2,
      occupiedHullDoubledAreaGrid2: topologyExact.exactHullDoubledAreaGrid2,
      occupiedHullWasteDoubledAreaGrid2: (
        occupiedHullDoubledArea - occupiedDoubledArea
      ).toString(),
      largestPositiveContactComponentSize:
        topology.largestPositiveContactComponentSize,
      placedPieceCount: state.placedCollisionGeometries.length,
      occupiedOutsideLargestContactComponentDoubledAreaGrid2:
        occupiedOutsideLargestDoubledArea.toString()
    }
  }
  return Object.entries(metrics).every(([key, value]) =>
    key === 'exact'
      ? value !== undefined
      : typeof value === 'string'
        ? value.length > 0
        : Number.isFinite(value)
  )
    ? metrics
    : undefined
}

function intrinsicBoundsSheet(state: IrregularBeamState): SheetSpec {
  const bounds = state.translatedCollisionBounds
  return new SheetSpec({
    width: Math.max(1, Math.ceil(bounds?.maxX ?? 0)),
    height: Math.max(1, Math.ceil(bounds?.maxY ?? 0)),
    label: 'intrinsic-completed-layout-bounds'
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

export function evaluateIntrinsicStrictCertificate(
  metrics: IntrinsicStrictCompletedMetrics
): IntrinsicStrictCertificate {
  const floors = INTRINSIC_STRICT_COHESION_FLOORS
  const violations: Array<keyof typeof floors> = []
  let relativeDeficitSum = 0
  if (metrics.enclosedCavityCount > floors.maximumEnclosedCavityCount) {
    violations.push('maximumEnclosedCavityCount')
    relativeDeficitSum += Math.min(
      1,
      (metrics.enclosedCavityCount - floors.maximumEnclosedCavityCount) /
        Math.max(1, floors.maximumEnclosedCavityCount)
    )
  }
  if (metrics.isolatedPieceCount > floors.maximumIsolatedPieceCount) {
    violations.push('maximumIsolatedPieceCount')
    relativeDeficitSum += Math.min(
      1,
      (metrics.isolatedPieceCount - floors.maximumIsolatedPieceCount) /
        Math.max(1, floors.maximumIsolatedPieceCount)
    )
  }
  const largestComponentBelowFloor =
    metrics.exact === undefined
      ? metrics.largestPositiveContactComponentRatio <
        floors.minimumLargestPositiveContactComponentRatio
      : 5n * BigInt(metrics.exact.largestPositiveContactComponentSize) <
        4n * BigInt(metrics.exact.placedPieceCount)
  if (largestComponentBelowFloor) {
    violations.push('minimumLargestPositiveContactComponentRatio')
    relativeDeficitSum += Math.min(
      1,
      (floors.minimumLargestPositiveContactComponentRatio -
        metrics.largestPositiveContactComponentRatio) /
        floors.minimumLargestPositiveContactComponentRatio
    )
  }
  const largestHullGapAboveFloor =
    metrics.exact === undefined
      ? metrics.largestOccupiedHullGapRatio > floors.maximumLargestOccupiedHullGapRatio
      : 20n * BigInt(metrics.exact.largestOccupiedHullGapDoubledAreaGrid2) >
        3n * BigInt(metrics.exact.occupiedHullDoubledAreaGrid2)
  if (largestHullGapAboveFloor) {
    violations.push('maximumLargestOccupiedHullGapRatio')
    relativeDeficitSum += Math.min(
      1,
      (metrics.largestOccupiedHullGapRatio - floors.maximumLargestOccupiedHullGapRatio) /
        floors.maximumLargestOccupiedHullGapRatio
    )
  }
  const exactRelativeDeficit = exactStrictRelativeDeficit(metrics)
  return {
    passes: violations.length === 0,
    violatedFloors: violations,
    relativeDeficitSum,
    ...(exactRelativeDeficit === undefined
      ? {}
      : {
          exactRelativeDeficitNumerator: exactRelativeDeficit.numerator.toString(),
          exactRelativeDeficitDenominator: exactRelativeDeficit.denominator.toString()
        })
  }
}

interface ExactFraction {
  readonly numerator: bigint
  readonly denominator: bigint
}

function greatestCommonDivisor(first: bigint, second: bigint): bigint {
  let left = first < 0n ? -first : first
  let right = second < 0n ? -second : second
  while (right !== 0n) {
    const remainder = left % right
    left = right
    right = remainder
  }
  return left
}

function normalizedFraction(numerator: bigint, denominator: bigint): ExactFraction {
  if (denominator <= 0n) return { numerator: 0n, denominator: 1n }
  const divisor = greatestCommonDivisor(numerator, denominator)
  return {
    numerator: numerator / (divisor === 0n ? 1n : divisor),
    denominator: denominator / (divisor === 0n ? 1n : divisor)
  }
}

function addFractions(first: ExactFraction, second: ExactFraction): ExactFraction {
  return normalizedFraction(
    first.numerator * second.denominator + second.numerator * first.denominator,
    first.denominator * second.denominator
  )
}

function cappedDeficit(numerator: bigint, denominator: bigint): ExactFraction {
  if (numerator <= 0n) return { numerator: 0n, denominator: 1n }
  return numerator >= denominator
    ? { numerator: 1n, denominator: 1n }
    : normalizedFraction(numerator, denominator)
}

function exactStrictRelativeDeficit(
  metrics: IntrinsicStrictCompletedMetrics
): ExactFraction | undefined {
  if (metrics.exact === undefined) return undefined
  let total: ExactFraction = { numerator: 0n, denominator: 1n }
  if (metrics.enclosedCavityCount > 2) {
    total = addFractions(
      total,
      cappedDeficit(BigInt(metrics.enclosedCavityCount - 2), 2n)
    )
  }
  if (metrics.isolatedPieceCount > 2) {
    total = addFractions(
      total,
      cappedDeficit(BigInt(metrics.isolatedPieceCount - 2), 2n)
    )
  }
  const placedCount = BigInt(metrics.exact.placedPieceCount)
  const largestComponent = BigInt(metrics.exact.largestPositiveContactComponentSize)
  if (5n * largestComponent < 4n * placedCount) {
    total = addFractions(
      total,
      cappedDeficit(4n * placedCount - 5n * largestComponent, 4n * placedCount)
    )
  }
  const hull = BigInt(metrics.exact.occupiedHullDoubledAreaGrid2)
  const hullGap = BigInt(metrics.exact.largestOccupiedHullGapDoubledAreaGrid2)
  if (20n * hullGap > 3n * hull) {
    total = addFractions(total, cappedDeficit(20n * hullGap - 3n * hull, 3n * hull))
  }
  return total
}

type IntrinsicStrictParetoComparison = -1 | 0 | 1

interface IntrinsicStrictParetoObjective {
  readonly compare: (
    first: IntrinsicStrictCompletedMetrics,
    second: IntrinsicStrictCompletedMetrics
  ) => number
}

function compareBigIntAscending(first: bigint, second: bigint): number {
  return first === second ? 0 : first < second ? -1 : 1
}

function compareExactRatio(
  firstNumerator: bigint,
  firstDenominator: bigint,
  secondNumerator: bigint,
  secondDenominator: bigint
): number {
  if (firstDenominator <= 0n || secondDenominator <= 0n) {
    return compareBigIntAscending(firstNumerator, secondNumerator)
  }
  return compareBigIntAscending(
    firstNumerator * secondDenominator,
    secondNumerator * firstDenominator
  )
}

function compareIntrinsicStrictCompactness(
  first: IntrinsicStrictCompletedMetrics,
  second: IntrinsicStrictCompletedMetrics
): number {
  if (first.exact !== undefined && second.exact !== undefined) {
    return (
      first.exact.envelopeMaximumSideGrid - second.exact.envelopeMaximumSideGrid ||
      compareBigIntAscending(
        BigInt(first.exact.envelopeAreaGrid2),
        BigInt(second.exact.envelopeAreaGrid2)
      ) ||
      first.exact.envelopeSpanGrid - second.exact.envelopeSpanGrid
    )
  }
  return (
    canonicalLinearMetric(first.envelopeMaximumSideMm) -
      canonicalLinearMetric(second.envelopeMaximumSideMm) ||
    canonicalAreaMetric(first.envelopeAreaMm2) -
      canonicalAreaMetric(second.envelopeAreaMm2) ||
    canonicalLinearMetric(first.envelopeSpanMm) -
      canonicalLinearMetric(second.envelopeSpanMm)
  )
}

function compareIntrinsicStrictVoidTopology(
  first: IntrinsicStrictCompletedMetrics,
  second: IntrinsicStrictCompletedMetrics
): number {
  const cavityCount = first.enclosedCavityCount - second.enclosedCavityCount
  if (cavityCount !== 0) return cavityCount
  if (first.exact !== undefined && second.exact !== undefined) {
    return (
      compareBigIntAscending(
        BigInt(first.exact.totalEnclosedCavityDoubledAreaGrid2),
        BigInt(second.exact.totalEnclosedCavityDoubledAreaGrid2)
      ) ||
      compareExactRatio(
        BigInt(first.exact.largestOccupiedHullGapDoubledAreaGrid2),
        BigInt(first.exact.occupiedHullDoubledAreaGrid2),
        BigInt(second.exact.largestOccupiedHullGapDoubledAreaGrid2),
        BigInt(second.exact.occupiedHullDoubledAreaGrid2)
      ) ||
      compareExactRatio(
        BigInt(first.exact.occupiedHullWasteDoubledAreaGrid2),
        BigInt(first.exact.occupiedHullDoubledAreaGrid2),
        BigInt(second.exact.occupiedHullWasteDoubledAreaGrid2),
        BigInt(second.exact.occupiedHullDoubledAreaGrid2)
      )
    )
  }
  return (
    canonicalAreaMetric(first.totalEnclosedCavityAreaMm2) -
      canonicalAreaMetric(second.totalEnclosedCavityAreaMm2) ||
    first.largestOccupiedHullGapRatio - second.largestOccupiedHullGapRatio ||
    first.occupiedHullWasteRatio - second.occupiedHullWasteRatio
  )
}

function compareIntrinsicStrictContact(
  first: IntrinsicStrictCompletedMetrics,
  second: IntrinsicStrictCompletedMetrics
): number {
  const discrete =
    first.isolatedPieceCount - second.isolatedPieceCount ||
    first.positiveContactComponentCount - second.positiveContactComponentCount ||
    second.largestPositiveContactComponentSize -
      first.largestPositiveContactComponentSize
  if (discrete !== 0) return discrete
  if (first.exact !== undefined && second.exact !== undefined) {
    const ratioComparison = compareExactRatio(
      BigInt(second.exact.largestPositiveContactComponentSize),
      BigInt(second.exact.placedPieceCount),
      BigInt(first.exact.largestPositiveContactComponentSize),
      BigInt(first.exact.placedPieceCount)
    )
    if (ratioComparison !== 0) return ratioComparison
    const outsideAreaComparison = compareBigIntAscending(
      BigInt(first.exact.occupiedOutsideLargestContactComponentDoubledAreaGrid2),
      BigInt(second.exact.occupiedOutsideLargestContactComponentDoubledAreaGrid2)
    )
    if (outsideAreaComparison !== 0) return outsideAreaComparison
  } else {
    const legacy =
      second.largestPositiveContactComponentRatio -
        first.largestPositiveContactComponentRatio ||
      canonicalAreaMetric(first.occupiedAreaOutsideLargestContactComponentMm2) -
        canonicalAreaMetric(second.occupiedAreaOutsideLargestContactComponentMm2)
    if (legacy !== 0) return legacy
  }
  return (
    second.totalStructuralContacts - first.totalStructuralContacts ||
    second.dominantStructuralContacts - first.dominantStructuralContacts ||
    second.contactUnits - first.contactUnits ||
    canonicalLinearMetric(second.sharedBoundaryLengthMm) -
      canonicalLinearMetric(first.sharedBoundaryLengthMm)
  )
}

const intrinsicStrictCompactnessObjective: IntrinsicStrictParetoObjective = {
  compare: compareIntrinsicStrictCompactness
}

const intrinsicStrictVoidTopologyObjective: IntrinsicStrictParetoObjective = {
  compare: compareIntrinsicStrictVoidTopology
}

const intrinsicStrictContactObjective: IntrinsicStrictParetoObjective = {
  compare: compareIntrinsicStrictContact
}

const intrinsicStrictGeometricObjectives: ReadonlyArray<IntrinsicStrictParetoObjective> = [
  intrinsicStrictCompactnessObjective,
  intrinsicStrictVoidTopologyObjective
]

const intrinsicStrictFrontSelectionObjectives: ReadonlyArray<IntrinsicStrictParetoObjective> = [
  intrinsicStrictCompactnessObjective,
  intrinsicStrictVoidTopologyObjective,
  intrinsicStrictContactObjective
]

/**
 * Compares exact completed layouts by compactness and void topology.
 * A negative result means the first layout dominates the second; zero means
 * equality or a genuine tradeoff and is deliberately not a scalar tie. Exact
 * contact receives one bounded archive-selection turn, but cannot veto strict
 * improvement on both geometric axes.
 */
export function compareIntrinsicStrictCompletedLayoutDominance(
  first: IntrinsicStrictCompletedMetrics,
  second: IntrinsicStrictCompletedMetrics
): IntrinsicStrictParetoComparison {
  let firstBetter = false
  let secondBetter = false
  for (const objective of intrinsicStrictGeometricObjectives) {
    const comparison = objective.compare(first, second)
    firstBetter ||= comparison < 0
    secondBetter ||= comparison > 0
    if (firstBetter && secondBetter) return 0
  }
  return firstBetter ? -1 : secondBetter ? 1 : 0
}

export function intrinsicStrictCompletedLayoutDominates(
  first: IntrinsicStrictCompletedMetrics,
  second: IntrinsicStrictCompletedMetrics
): boolean {
  return compareIntrinsicStrictCompletedLayoutDominance(first, second) < 0
}

/** Removes every geometrically dominated layout and orders the surviving front. */
export function selectIntrinsicStrictCompletedParetoFront(
  layouts: ReadonlyArray<IntrinsicStrictCompletedMetrics>
): ReadonlyArray<IntrinsicStrictCompletedMetrics> {
  const frontier = layouts.filter(
    (candidate) =>
      !layouts.some(
        (other) => other !== candidate && intrinsicStrictCompletedLayoutDominates(other, candidate)
      )
  )
  return orderIntrinsicStrictParetoFront(frontier)
}

/** Orders geometric Pareto fronts without turning diagnostic floors into hard partitions. */
export function rankIntrinsicStrictCompletedLayouts(
  layouts: ReadonlyArray<IntrinsicStrictCompletedMetrics>
): ReadonlyArray<IntrinsicStrictCompletedMetrics> {
  return rankIntrinsicStrictParetoPartition(layouts)
}

function rankIntrinsicStrictParetoPartition(
  layouts: ReadonlyArray<IntrinsicStrictCompletedMetrics>
): ReadonlyArray<IntrinsicStrictCompletedMetrics> {
  const remaining = [...layouts]
  const ranked: IntrinsicStrictCompletedMetrics[] = []
  while (remaining.length > 0) {
    const frontier = remaining.filter(
      (candidate) =>
        !remaining.some(
          (other) =>
            other !== candidate && intrinsicStrictCompletedLayoutDominates(other, candidate)
        )
    )
    if (frontier.length === 0) {
      return [
        ...ranked,
        ...remaining.toSorted((first, second) =>
          first.canonicalGeometryHash.localeCompare(second.canonicalGeometryHash)
        )
      ]
    }
    ranked.push(...orderIntrinsicStrictParetoFront(frontier))
    const frontierMembers = new Set(frontier)
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const candidate = remaining[index]
      if (candidate !== undefined && frontierMembers.has(candidate)) remaining.splice(index, 1)
    }
  }
  return ranked
}

function orderIntrinsicStrictParetoFront(
  frontier: ReadonlyArray<IntrinsicStrictCompletedMetrics>
): ReadonlyArray<IntrinsicStrictCompletedMetrics> {
  const remaining = [...frontier]
  const ordered: IntrinsicStrictCompletedMetrics[] = []
  while (remaining.length > 0) {
    let selectedAny = false
    for (const objective of intrinsicStrictFrontSelectionObjectives) {
      const selected = remaining.toSorted(
        (first, second) =>
          objective.compare(first, second) ||
          first.canonicalGeometryHash.localeCompare(second.canonicalGeometryHash)
      )[0]
      if (selected === undefined) continue
      ordered.push(selected)
      remaining.splice(remaining.indexOf(selected), 1)
      selectedAny = true
      if (remaining.length === 0) break
    }
    if (!selectedAny) break
  }
  return ordered
}

function makeResult(input: {
  readonly status: IntrinsicStrictDecodeResult['status']
  readonly state: IrregularBeamState
  readonly stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>
  readonly runtimeMs: number
}): IntrinsicStrictDecodeResult {
  return {
    status: input.status,
    placements: input.state.placedCollisionGeometries.map(({ placement }) => placement),
    placedCollisionGeometries: input.state.placedCollisionGeometries,
    unplacedPieceIds: input.state.unplacedPieceIds,
    terminalRotationDeg: undefined,
    canonicalGeometryHash: undefined,
    metrics: undefined,
    certificate: undefined,
    stepTrace: input.stepTrace,
    runtimeMs: input.runtimeMs
  }
}
