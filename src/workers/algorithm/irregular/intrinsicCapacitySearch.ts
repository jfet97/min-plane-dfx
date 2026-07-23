import { Effect } from 'effect'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularTransform,
  type IrregularPlacementCandidate,
  type IrregularPreparedPiece,
  type TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import {
  measureCanonicalLayoutTopologyExact,
  type CanonicalLayoutTopologyExact
} from '../../irregular/canonicalLayoutGeometry.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularNfpIfpCandidateMemoScope,
  NfpIfpService,
  type IrregularGeometryInputError,
  type IrregularNestingNotImplementedError,
  type IrregularNfpIfpControl,
  type IrregularNfpIfpControlAbortError
} from '../../irregular/services.js'
import {
  compareIntrinsicCapacityEndpoints,
  intrinsicCapacitySpanFitsSheet,
  intrinsicCapacityStateGridSpan,
  materializeIntrinsicCapacityEndpoint,
  measureIntrinsicCapacityCavities,
  type IntrinsicCapacityCavityCache,
  type IntrinsicCapacityCavityMetrics,
  type IntrinsicCapacityEndpoint,
  type IntrinsicCapacityGridSpan
} from './intrinsicCapacityEndpoint.js'
import {
  intrinsicCapacityPreparedPieceId
} from './intrinsicCapacityMaterial.js'
import { IntrinsicCapacityError } from './intrinsicCapacityPreflight.js'
import {
  IrregularPlacementScorer
} from './irregularPlacementScorer.js'
import {
  INTRINSIC_COORDINATE_DOMAIN,
  originAnchorCandidates,
  transformCandidateOrder
} from './intrinsicStrictDecoder.js'
import { IrregularBeamState } from './irregularBeamState.js'

/** Fixed first-version bounds of the empty-start intrinsic capacity search. */
export const INTRINSIC_CAPACITY_V1_BOUNDS = {
  coldBeamWidth: 16,
  localLegalPlacementFanout: 3,
  minimumPlacementEvaluationCap: 50_000,
  placementEvaluationQuotaPerDepth: 4_096
} as const

export const INTRINSIC_ANYTIME_CHECKPOINT_VERSION = 'intrinsic-anytime-checkpoint-v2' as const

export type IntrinsicCapacitySettlement = 'exhausted' | 'evaluation-cap' | 'paused'

export type IntrinsicAnytimeProducerRole =
  | 'capacity-cold'
  | 'capacity-cohesion-shadow'
  | 'capacity-warm-prefix'
  | 'legacy-complete'
  | 'experimental-place-defer-complete'

export type IntrinsicAnytimeArchiveCohort =
  | 'complete'
  | 'partial'
  | 'experimental-complete'

export type IntrinsicAnytimeEligibility = 'completeEligible' | 'subsetOnly'

export type IntrinsicCapacityRetentionMode =
  | 'objective'
  | 'area-first-shadow'
  | 'axis-buckets-shadow'
  | 'cohesion-frontier-shadow'

export interface IntrinsicAnytimeFitMask {
  readonly q0: boolean
  readonly q90: boolean
}

export interface IntrinsicAnytimeDecisionState {
  readonly state: IrregularBeamState
  /** Exact private metadata consumed by the next placement after resume. */
  readonly continuationMetadataIdentity: string
  readonly eligibility: IntrinsicAnytimeEligibility
  readonly placedPreparedIds: ReadonlyArray<PieceId>
  readonly pendingPreparedIds: ReadonlyArray<PieceId>
  readonly deferredPreparedIds: ReadonlyArray<PieceId>
  readonly permanentlySkippedPreparedIds: ReadonlyArray<PieceId>
  readonly pendingOrder: ReadonlyArray<PieceId>
  readonly cursor: number
  readonly pass: number
  readonly deferralCounts: Readonly<Record<string, number>>
  readonly placedDoubledMaterialAreaGrid2: bigint
  readonly cavities: IntrinsicCapacityCavityMetrics
  readonly anchoredOccupiedKey: string
  readonly gridSpan: IntrinsicCapacityGridSpan
  readonly fitMask: IntrinsicAnytimeFitMask
}

export interface IntrinsicAnytimeDepthBudgetLedger {
  readonly depth: number
  readonly consumedPlacementEvaluations: number
  readonly quotaExhausted: boolean
}

export interface IntrinsicAnytimeBudgetLedgers {
  readonly totalPlacementEvaluationCap: number
  readonly totalConsumedPlacementEvaluations: number
  readonly perDepth: ReadonlyArray<IntrinsicAnytimeDepthBudgetLedger>
  readonly perCohort: Readonly<{
    readonly complete: number
    readonly partial: number
    readonly experimentalComplete: number
  }>
}

export interface IntrinsicAnytimeNoSkipFrontierState {
  readonly present: boolean
  readonly firstLossDepth: number | undefined
}

export interface IntrinsicAnytimeIncumbentBinding {
  readonly canonicalGeometryHash: string
  readonly placedCount: number
  readonly placedDoubledMaterialAreaGrid2: bigint
  readonly origin: IntrinsicCapacityEndpoint['origin']
  readonly selectedRotationDeg: 0 | 90
}

export interface IntrinsicCapacitySearchCounters {
  readonly prunedByAttainableCount: number
  readonly prunedByAttainableMaterial: number
  readonly deduplicatedSuccessors: number
  readonly fitRejectedCandidates: number
  readonly invalidCandidates: number
  readonly endpointFitRejections: number
  readonly completedDepths: number
  readonly depthQuotaExhaustions: number
}

export interface IntrinsicAnytimeCheckpoint {
  readonly version: typeof INTRINSIC_ANYTIME_CHECKPOINT_VERSION
  readonly requestFingerprint: string
  readonly producerRole: IntrinsicAnytimeProducerRole
  readonly archiveCohort: IntrinsicAnytimeArchiveCohort
  readonly searchBounds: typeof INTRINSIC_CAPACITY_V1_BOUNDS
  readonly incumbentBinding: IntrinsicAnytimeIncumbentBinding | undefined
  readonly frontier: ReadonlyArray<IntrinsicAnytimeDecisionState>
  readonly nextDepth: number
  readonly depthBoundaryResumePosition: number
  readonly budgetLedgers: IntrinsicAnytimeBudgetLedgers
  readonly schedulerDeficit: number
  readonly settlement: 'active'
  readonly censoring: 'none'
  readonly noSkipFrontier: IntrinsicAnytimeNoSkipFrontierState
  readonly counters: IntrinsicCapacitySearchCounters
  readonly integrityHash: string
}

export interface IntrinsicCapacitySearchTrace {
  readonly beamWidth: number
  readonly localLegalPlacementFanout: number
  readonly placementEvaluationCap: number
  readonly placementEvaluationQuotaPerDepth: number
  readonly consumedPlacementEvaluations: number
  /** Prefix terminalization must never consume placement evaluations. */
  readonly auxiliaryPlacementEvaluations: number
  readonly prunedByAttainableCount: number
  readonly prunedByAttainableMaterial: number
  readonly deduplicatedSuccessors: number
  readonly fitRejectedCandidates: number
  readonly invalidCandidates: number
  readonly endpointFitRejections: number
  readonly completedDepths: number
  readonly depthQuotaExhaustions: number
  readonly pieceCount: number
  readonly settlement: IntrinsicCapacitySettlement
  /** Observer-only exact topology representatives around each retention boundary. */
  readonly topologyRetentionDepths:
    | ReadonlyArray<IntrinsicCapacityTopologyRetentionDepthTrace>
    | undefined
}

export type IntrinsicCapacityTopologyRepresentativeRole =
  | 'terminal-objective'
  | 'minimum-components'
  | 'minimum-isolated'
  | 'maximum-largest-component'
  | 'minimum-hull-waste'

export interface IntrinsicCapacityTopologyRepresentative {
  readonly role: IntrinsicCapacityTopologyRepresentativeRole
  readonly decisionIdentity: string
  readonly parentDecisionIdentity: string
  readonly decision: 'place' | 'skip'
  readonly proposalRole: 'compactness' | 'contact' | 'skip'
  readonly pieceId: PieceId
  readonly anchoredOccupiedKey: string
  readonly placedCount: number
  readonly placedDoubledMaterialAreaGrid2: bigint
  readonly cavities: IntrinsicCapacityCavityMetrics
  readonly gridSpan: IntrinsicCapacityGridSpan
  readonly topology: CanonicalLayoutTopologyExact | undefined
  readonly retained: boolean
}

export interface IntrinsicCapacityTopologyRetentionDepthTrace {
  readonly depth: number
  readonly pieceId: PieceId
  readonly measuredSurvivorCount: number
  readonly retainedCount: number
  readonly bestAccountingStratumCount: number
  readonly topologyMeasurementCount: number
  readonly topologyMeasurementMs: number
  readonly legalCandidateCount: number
  readonly contactMeasuredCandidateCount: number
  readonly positiveContactCandidateCount: number
  readonly contactMeasurementMs: number
  readonly contactSelectedSuccessorCount: number
  readonly contactDeduplicatedSuccessorCount: number
  readonly contactRetainedSuccessorCount: number
  readonly representatives: ReadonlyArray<IntrinsicCapacityTopologyRepresentative>
}

/** Benchmark-only phase buckets; capture must default off in production. */
export interface IntrinsicCapacitySearchPhaseTimings {
  readonly candidateGenerationMs: number
  readonly candidateEvaluationMs: number
  readonly successorConstructionMs: number
  readonly cavityMeasurementMs: number
  readonly retentionMs: number
  readonly endpointMaterializationMs: number
  readonly totalMs: number
}

export interface IntrinsicCapacitySearchResult {
  readonly status: 'paused' | 'settled'
  /** Deduplicated cold endpoints ranked by the capacity objective. */
  readonly endpoints: ReadonlyArray<IntrinsicCapacityEndpoint>
  readonly trace: IntrinsicCapacitySearchTrace
  readonly phaseTimings: IntrinsicCapacitySearchPhaseTimings | undefined
  readonly checkpoint: IntrinsicAnytimeCheckpoint | undefined
}

export interface RunIntrinsicCapacityColdSearchInput {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly materialAreasByPieceId: ReadonlyMap<PieceId, bigint>
  readonly cavityCache: IntrinsicCapacityCavityCache
  /** Optional prefix incumbent used only for the strict attainable bounds. */
  readonly incumbent?: IntrinsicCapacityEndpoint
  readonly control?: IrregularNfpIfpControl
  readonly capturePhaseTimings?: boolean
  /** Resume only from a validated depth-boundary checkpoint. */
  readonly checkpoint?: IntrinsicAnytimeCheckpoint
  /** Test/scheduler seam. Omit to run through settlement. */
  readonly maximumDepthBoundaries?: number
  /** Exact fitting, skip-free prefix used only by an independent warm lane. */
  readonly warmPrefixSeed?: IntrinsicCapacityWarmPrefixSeed
  /** Deterministic scheduler credit carried by a paused protected lane. */
  readonly schedulerDeficit?: number
  /** Experimental protected-lane retention; terminal objective stays unchanged. */
  readonly retentionMode?: IntrinsicCapacityRetentionMode
}

export interface IntrinsicCapacityWarmPrefixSeed {
  readonly sourceRole: string
  readonly depth: number
  readonly state: IrregularBeamState
}

interface CapacityBeamEntry {
  readonly state: IrregularBeamState
  readonly placedDoubledMaterialAreaGrid2: bigint
  readonly anchoredOccupiedKey: string
  readonly gridSpan: IntrinsicCapacityGridSpan
  readonly cavities: IntrinsicCapacityCavityMetrics
  readonly observerTransition?: {
    readonly parentDecisionIdentity: string
    readonly decision: 'place' | 'skip'
    readonly proposalRole: 'compactness' | 'contact' | 'skip'
    readonly pieceId: PieceId
  }
}

interface ScoredCandidateReference {
  readonly moving: TransformedCollisionGeometry
  readonly candidate: IrregularPlacementCandidate
  readonly maximumSideGrid: number
  readonly envelopeAreaGrid2: number
  readonly envelopeSpanGrid: number
  readonly transformOrdinal: number
  readonly gridX: number
  readonly gridY: number
}

type CapacitySearchError =
  | IntrinsicCapacityError
  | IrregularGeometryInputError
  | IrregularNestingNotImplementedError
  | IrregularNfpIfpControlAbortError

/**
 * Empty-start intrinsic capacity search `intrinsic-capacity-v1`.
 *
 * A depth-synchronized cold beam processes the immutable prepared order. At
 * every piece depth each retained state emits up to three ordinary legal
 * placement successors and one mandatory skip successor. Successors are
 * checked for exact partial q0/q90 fit and deduplicated by canonical
 * occupied-union identity before retention; states from different piece depths
 * never compete. The prefix incumbent may prune only through the strict
 * attainable-count and attainable-material bounds. A reached evaluation cap
 * settles the best retained endpoints deterministically.
 */
export function runIntrinsicCapacityColdSearch(
  input: RunIntrinsicCapacityColdSearchInput
): Effect.Effect<
  IntrinsicCapacitySearchResult,
  CapacitySearchError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const capture = input.capturePhaseTimings === true
    const captureTopologyRetention =
      input.retentionMode === 'cohesion-frontier-shadow'
    const settings = yield* GeometrySettings
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const {
      coldBeamWidth,
      localLegalPlacementFanout,
      minimumPlacementEvaluationCap,
      placementEvaluationQuotaPerDepth
    } = INTRINSIC_CAPACITY_V1_BOUNDS
    const placementEvaluationCap = Math.max(
      minimumPlacementEvaluationCap,
      input.preparedPieces.length * placementEvaluationQuotaPerDepth
    )

    const sheetWidthGrid = toGridMm(input.sheet.width)
    const sheetHeightGrid = toGridMm(input.sheet.height)
    if (sheetWidthGrid === undefined || sheetHeightGrid === undefined) {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'coldSearchSheet',
          message: 'requested sheet has no exact canonical-grid representation.'
        })
      )
    }
    const preparedIds = input.preparedPieces.map(intrinsicCapacityPreparedPieceId)
    const suffixMaterial = suffixMaterialSums(preparedIds, input.materialAreasByPieceId)
    if (suffixMaterial === undefined) {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'coldSearchMaterial',
          message: 'capacity material accounting is incomplete for the prepared pieces.'
        })
      )
    }
    const warmPrefix = validateWarmPrefixSeed({
      seed: input.warmPrefixSeed,
      preparedPieces: input.preparedPieces,
      preparedIds,
      materialAreasByPieceId: input.materialAreasByPieceId,
      cavityCache: input.cavityCache,
      sheetWidthGrid,
      sheetHeightGrid
    })
    if (warmPrefix.kind === 'invalid') {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'warmPrefixSeed',
          message: warmPrefix.message
        })
      )
    }
    const initialDepth = warmPrefix.entry?.depth ?? 0
    const producerRole: IntrinsicAnytimeProducerRole =
      warmPrefix.entry === undefined
        ? input.retentionMode === 'cohesion-frontier-shadow'
          ? 'capacity-cohesion-shadow'
          : 'capacity-cold'
        : 'capacity-warm-prefix'
    const maximumDepthBoundaries = input.maximumDepthBoundaries
    if (
      maximumDepthBoundaries !== undefined &&
      (!Number.isSafeInteger(maximumDepthBoundaries) || maximumDepthBoundaries <= 0)
    ) {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'coldSearchCheckpoint',
          message: 'maximumDepthBoundaries must be a positive safe integer.'
        })
      )
    }
    const checkpointEnabled = input.checkpoint !== undefined || maximumDepthBoundaries !== undefined
    const requestFingerprint = checkpointEnabled
      ? intrinsicCapacityRequestFingerprint(input)
      : undefined
    if (input.checkpoint !== undefined) {
      if (requestFingerprint === undefined) {
        return yield* Effect.fail(
          new IntrinsicCapacityError({
            operation: 'coldSearchCheckpoint',
            message: 'checkpoint fingerprinting must be enabled for resume.'
          })
        )
      }
      const checkpointError = validateIntrinsicCapacityCheckpoint({
        checkpoint: input.checkpoint,
        requestFingerprint,
        incumbentBinding: intrinsicCapacityIncumbentBinding(input.incumbent),
        producerRole,
        schedulerDeficit: input.schedulerDeficit ?? 0,
        preparedIds,
        materialAreasByPieceId: input.materialAreasByPieceId,
        placementEvaluationCap,
        sheetWidthGrid,
        sheetHeightGrid
      })
      if (checkpointError !== undefined) {
        return yield* Effect.fail(
          new IntrinsicCapacityError({
            operation: 'coldSearchCheckpoint',
            message: checkpointError
          })
        )
      }
    }

    const candidateMemoScope = new IrregularNfpIfpCandidateMemoScope()
    const timings = {
      candidateGenerationMs: 0,
      candidateEvaluationMs: 0,
      successorConstructionMs: 0,
      cavityMeasurementMs: 0,
      retentionMs: 0,
      endpointMaterializationMs: 0
    }
    const resumedCounters = input.checkpoint?.counters
    let consumedPlacementEvaluations =
      input.checkpoint?.budgetLedgers.totalConsumedPlacementEvaluations ?? 0
    let prunedByAttainableCount = resumedCounters?.prunedByAttainableCount ?? 0
    let prunedByAttainableMaterial = resumedCounters?.prunedByAttainableMaterial ?? 0
    let deduplicatedSuccessors = resumedCounters?.deduplicatedSuccessors ?? 0
    let fitRejectedCandidates = resumedCounters?.fitRejectedCandidates ?? 0
    let invalidCandidates = resumedCounters?.invalidCandidates ?? 0
    let endpointFitRejections = resumedCounters?.endpointFitRejections ?? 0
    let completedDepths = resumedCounters?.completedDepths ?? initialDepth
    let depthQuotaExhaustions = resumedCounters?.depthQuotaExhaustions ?? 0
    let settlement: IntrinsicCapacitySettlement = 'exhausted'
    let perDepthBudgetLedgers: ReadonlyArray<IntrinsicAnytimeDepthBudgetLedger> =
      input.checkpoint?.budgetLedgers.perDepth ??
      Array.from({ length: initialDepth }, (_, depth) => ({
        depth,
        consumedPlacementEvaluations: 0,
        quotaExhausted: false
      }))
    let noSkipFrontier: IntrinsicAnytimeNoSkipFrontierState =
      input.checkpoint?.noSkipFrontier ?? {
        present: true,
        firstLossDepth: undefined
      }
    const startDepth = input.checkpoint?.nextDepth ?? initialDepth
    let completedDepthBoundariesThisInvocation = 0
    const topologyRetentionDepths: IntrinsicCapacityTopologyRetentionDepthTrace[] = []

    let beam: ReadonlyArray<CapacityBeamEntry>
    if (input.checkpoint === undefined && warmPrefix.entry !== undefined) {
      beam = [warmPrefix.entry.beamEntry]
    } else if (input.checkpoint === undefined) {
      const emptyState = IrregularBeamState.empty(input.preparedPieces)
      const emptySpan = intrinsicCapacityStateGridSpan(emptyState)
      if (emptySpan === undefined) {
        return yield* Effect.fail(
          new IntrinsicCapacityError({
            operation: 'coldSearchEmptyState',
            message: 'the empty capacity state must have finite occupied bounds.'
          })
        )
      }
      beam = [
        {
          state: emptyState,
          placedDoubledMaterialAreaGrid2: 0n,
          anchoredOccupiedKey: emptyState.canonicalOccupiedGeometryKey,
          gridSpan: emptySpan,
          cavities: { count: 0, totalAreaMm2: 0 }
        }
      ]
    } else {
      beam = input.checkpoint.frontier.map((entry) => ({
        state: entry.state,
        placedDoubledMaterialAreaGrid2: entry.placedDoubledMaterialAreaGrid2,
        anchoredOccupiedKey: entry.anchoredOccupiedKey,
        gridSpan: entry.gridSpan,
        cavities: entry.cavities
      }))
    }

    for (let depth = startDepth; depth < input.preparedPieces.length; depth += 1) {
      const piece = input.preparedPieces[depth]
      if (piece === undefined) continue
      const pieceId = preparedIds[depth]
      if (pieceId === undefined) continue
      const pieceMaterial = input.materialAreasByPieceId.get(pieceId)
      if (pieceMaterial === undefined) {
        return yield* Effect.fail(
          new IntrinsicCapacityError({
            operation: 'coldSearchMaterial',
            message: `piece ${pieceId} has no exact material accounting.`
          })
        )
      }
      const remainingPreparedPieces = input.preparedPieces.slice(depth + 1)
      const successors: CapacityBeamEntry[] = []
      const successorKeys = new Set<string>()
      const contactSuccessorIdentities = new Set<string>()
      const contactFanoutTrace = {
        legalCandidateCount: 0,
        measuredCandidateCount: 0,
        positiveCandidateCount: 0,
        measurementMs: 0,
        selectedSuccessorCount: 0,
        deduplicatedSuccessorCount: 0
      }

      // reserve the skip path for every retained state before spending this depth's placement quota
      for (const entry of beam) {
        const skipState = entry.state.withUnplacedPiece({
          remainingPreparedPieces,
          unplacedPieceId: pieceId
        })
        pushSuccessor(
          successors,
          successorKeys,
          {
            state: skipState,
            placedDoubledMaterialAreaGrid2: entry.placedDoubledMaterialAreaGrid2,
            anchoredOccupiedKey: entry.anchoredOccupiedKey,
            gridSpan: entry.gridSpan,
            cavities: entry.cavities,
            ...(captureTopologyRetention
              ? {
                  observerTransition: {
                    parentDecisionIdentity:
                      intrinsicCapacitySuccessorIdentity(entry),
                    decision: 'skip' as const,
                    proposalRole: 'skip' as const,
                    pieceId
                  }
                }
              : {})
          },
          () => {
            deduplicatedSuccessors += 1
          }
        )
      }

      let consumedAtDepth = 0
      let depthQuotaExhausted = false
      for (const entry of beam) {
        if (depthQuotaExhausted) break
        const scored: EvaluatedCandidateReference[] = []
        const sortedTransforms = [...piece.transforms].sort((first, second) =>
          transformCandidateOrder(first, second)
        )
        for (
          let transformOrdinal = 0;
          transformOrdinal < sortedTransforms.length;
          transformOrdinal += 1
        ) {
          if (depthQuotaExhausted) break
          const transform = sortedTransforms[transformOrdinal]
          if (transform === undefined) continue
          const generationStartedAt = capture ? performance.now() : 0
          if (input.control !== undefined) yield* input.control.checkpoint('candidate-points')
          const moving = yield* geometryKernel.transformCollisionGeometry({
            geometry: piece.collisionGeometry,
            transform
          })
          const legalCandidates =
            entry.state.placedCollisionGeometries.length === 0
              ? originAnchorCandidates(moving)
              : yield* nfpIfpService.generatePlacementCandidates({
                  sheet: INTRINSIC_COORDINATE_DOMAIN,
                  placed: entry.state.placedCollisionGeometries,
                  placedCollisionIndex: entry.state.placedCollisionIndex,
                  moving,
                  settings,
                  candidateDomain: 'sheetless-nfp',
                  candidateMemoScope,
                  ...(input.control === undefined ? {} : { control: input.control })
                })
          if (captureTopologyRetention) {
            contactFanoutTrace.legalCandidateCount += legalCandidates.length
          }
          if (capture) timings.candidateGenerationMs += performance.now() - generationStartedAt

          const evaluationStartedAt = capture ? performance.now() : 0
          for (const candidate of legalCandidates) {
            if (
              consumedAtDepth >= placementEvaluationQuotaPerDepth ||
              consumedPlacementEvaluations >= placementEvaluationCap
            ) {
              settlement = 'evaluation-cap'
              depthQuotaExhausted = true
              if (capture) {
                timings.candidateEvaluationMs += performance.now() - evaluationStartedAt
              }
              break
            }
            consumedAtDepth += 1
            consumedPlacementEvaluations += 1
            const evaluated = evaluateCandidate(entry, moving, candidate, transformOrdinal)
            if (evaluated === undefined) {
              invalidCandidates += 1
              continue
            }
            const fits = intrinsicCapacitySpanFitsSheet(
              { widthGrid: evaluated.widthGrid, heightGrid: evaluated.heightGrid },
              sheetWidthGrid,
              sheetHeightGrid
            )
            if (!fits.q0 && !fits.q90) {
              fitRejectedCandidates += 1
              continue
            }
            if (captureTopologyRetention) {
              const contactStartedAt = performance.now()
              const contactScore =
                yield* IrregularPlacementScorer.Make.scoreCandidate({
                  sheet: INTRINSIC_COORDINATE_DOMAIN,
                  placed: entry.state.placedCollisionGeometries,
                  moving,
                  candidate
                }).pipe(
                  Effect.mapError(
                    (error) =>
                      new IntrinsicCapacityError({
                        operation: 'capacityContactFanout',
                        message: error.message
                      })
                  )
                )
              contactFanoutTrace.measuredCandidateCount += 1
              contactFanoutTrace.measurementMs += Math.max(
                0,
                performance.now() - contactStartedAt
              )
              if (contactScore.sharedCollisionBoundaryLengthMm > 0) {
                contactFanoutTrace.positiveCandidateCount += 1
              }
              scored.push({
                ...evaluated,
                sharedBoundaryLengthMm:
                  contactScore.sharedCollisionBoundaryLengthMm
              })
            } else {
              scored.push(evaluated)
            }
          }
          if (capture) timings.candidateEvaluationMs += performance.now() - evaluationStartedAt
        }

        const constructionStartedAt = capture ? performance.now() : 0
        scored.sort(compareScoredCandidateReferences)
        let builtCount = 0
        const builtCandidateKeys = new Set<string>()
        const buildReference = (
          reference: EvaluatedCandidateReference,
          proposalRole: 'compactness' | 'contact'
        ): { readonly added: boolean; readonly decisionIdentity?: string } => {
          builtCandidateKeys.add(capacityCandidateReferenceIdentity(reference))
          const placedState = entry.state.withPlacement({
            remainingPreparedPieces,
            placedCollisionGeometry: new IrregularPlacedPiece({
              placement: makeCapacityPlacement(piece, reference.candidate),
              collisionGeometry: reference.moving
            }),
            placementOrderPieceId: pieceId
          })
          const gridSpan = intrinsicCapacityStateGridSpan(placedState)
          if (gridSpan === undefined) {
            invalidCandidates += 1
            return { added: false }
          }
          const builtFits = intrinsicCapacitySpanFitsSheet(
            gridSpan,
            sheetWidthGrid,
            sheetHeightGrid
          )
          if (!builtFits.q0 && !builtFits.q90) {
            fitRejectedCandidates += 1
            return { added: false }
          }
          const anchoredOccupiedKey =
            placedState.bottomLeftAnchoredCanonicalOccupiedGeometryKey()
          if (anchoredOccupiedKey === undefined) {
            invalidCandidates += 1
            return { added: false }
          }
          const successor: CapacityBeamEntry = {
            state: placedState,
            placedDoubledMaterialAreaGrid2:
              entry.placedDoubledMaterialAreaGrid2 + pieceMaterial,
            anchoredOccupiedKey,
            gridSpan,
            cavities: { count: 0, totalAreaMm2: 0 },
            ...(captureTopologyRetention
              ? {
                  observerTransition: {
                    parentDecisionIdentity:
                      intrinsicCapacitySuccessorIdentity(entry),
                    decision: 'place' as const,
                    proposalRole,
                    pieceId
                  }
                }
              : {})
          }
          const decisionIdentity = intrinsicCapacitySuccessorIdentity(successor)
          const added = pushSuccessor(
            successors,
            successorKeys,
            successor,
            () => {
              deduplicatedSuccessors += 1
              if (proposalRole === 'contact') {
                contactFanoutTrace.deduplicatedSuccessorCount += 1
              }
            }
          )
          return { added, decisionIdentity }
        }
        for (const reference of scored) {
          if (builtCount >= localLegalPlacementFanout) break
          if (buildReference(reference, 'compactness').added) builtCount += 1
        }
        if (captureTopologyRetention) {
          const contactReference = scored
            .filter(
              (reference) =>
                (reference.sharedBoundaryLengthMm ?? 0) > 0 &&
                !builtCandidateKeys.has(
                  capacityCandidateReferenceIdentity(reference)
                )
            )
            .toSorted(compareContactCandidateReferences)[0]
          if (contactReference !== undefined) {
            const contactResult = buildReference(contactReference, 'contact')
            if (contactResult.added) {
              contactFanoutTrace.selectedSuccessorCount += 1
              if (contactResult.decisionIdentity !== undefined) {
                contactSuccessorIdentities.add(
                  contactResult.decisionIdentity
                )
              }
            }
          }
        }
        if (capture) timings.successorConstructionMs += performance.now() - constructionStartedAt
      }
      if (depthQuotaExhausted) depthQuotaExhaustions += 1

      const retentionStartedAt = capture ? performance.now() : 0
      const remainingCountAfterDepth = input.preparedPieces.length - (depth + 1)
      const remainingMaterialAfterDepth = suffixMaterial[depth + 1] ?? 0n
      const incumbent = input.incumbent
      const surviving: CapacityBeamEntry[] = []
      for (const successor of successors) {
        if (incumbent !== undefined) {
          const attainableCount = successor.state.placementOrder.length + remainingCountAfterDepth
          if (attainableCount < incumbent.metrics.placedCount) {
            prunedByAttainableCount += 1
            continue
          }
          if (attainableCount === incumbent.metrics.placedCount) {
            const attainableMaterial =
              successor.placedDoubledMaterialAreaGrid2 + remainingMaterialAfterDepth
            if (attainableMaterial < incumbent.metrics.placedDoubledMaterialAreaGrid2) {
              prunedByAttainableMaterial += 1
              continue
            }
          }
        }
        surviving.push(successor)
      }

      const cavityStartedAt = capture ? performance.now() : 0
      const measuredSurvivors: CapacityBeamEntry[] = []
      for (const successor of surviving) {
        if (successor.state.placementOrder.length === 0) {
          measuredSurvivors.push(successor)
          continue
        }
        const cavities = measureIntrinsicCapacityCavities(successor.state, input.cavityCache)
        if (cavities === undefined) {
          invalidCandidates += 1
          continue
        }
        measuredSurvivors.push({ ...successor, cavities })
      }
      if (capture) timings.cavityMeasurementMs += performance.now() - cavityStartedAt

      const topologyMeasurements =
        captureTopologyRetention ? makeCapacityTopologyMeasurements() : undefined
      beam = retainCapacityBeamEntries(
        measuredSurvivors,
        coldBeamWidth,
        input.retentionMode ?? 'objective',
        topologyMeasurements
      )
      if (topologyMeasurements !== undefined) {
        topologyRetentionDepths.push(
          makeCapacityTopologyRetentionDepthTrace({
            depth,
            pieceId,
            measuredSurvivors,
            retained: beam,
            topologyMeasurements,
            contactFanoutTrace: {
              ...contactFanoutTrace,
              retainedSuccessorCount: beam.filter((entry) =>
                contactSuccessorIdentities.has(
                  intrinsicCapacitySuccessorIdentity(entry)
                )
              ).length
            }
          })
        )
      }
      completedDepths = depth + 1
      completedDepthBoundariesThisInvocation += 1
      if (checkpointEnabled) {
        perDepthBudgetLedgers = [
          ...perDepthBudgetLedgers,
          {
            depth,
            consumedPlacementEvaluations: consumedAtDepth,
            quotaExhausted: depthQuotaExhausted
          }
        ]
        const hasNoSkipState = beam.some((entry) => entry.state.unplacedPieceIds.length === 0)
        noSkipFrontier = {
          present: hasNoSkipState,
          firstLossDepth:
            noSkipFrontier.firstLossDepth ??
            (noSkipFrontier.present && !hasNoSkipState ? depth + 1 : undefined)
        }
      }
      if (capture) timings.retentionMs += performance.now() - retentionStartedAt
      if (beam.length === 0) break
      if (
        maximumDepthBoundaries !== undefined &&
        completedDepthBoundariesThisInvocation >= maximumDepthBoundaries &&
        depth + 1 < input.preparedPieces.length
      ) {
        if (requestFingerprint === undefined) {
          return yield* Effect.fail(
            new IntrinsicCapacityError({
              operation: 'coldSearchCheckpoint',
              message: 'checkpoint fingerprint is unavailable at a requested pause boundary.'
            })
          )
        }
        const counters = capacitySearchCounters({
          prunedByAttainableCount,
          prunedByAttainableMaterial,
          deduplicatedSuccessors,
          fitRejectedCandidates,
          invalidCandidates,
          endpointFitRejections,
          completedDepths,
          depthQuotaExhaustions
        })
        const checkpoint = makeIntrinsicCapacityCheckpoint({
          requestFingerprint,
          incumbentBinding: intrinsicCapacityIncumbentBinding(input.incumbent),
          beam,
          preparedIds,
          nextDepth: depth + 1,
          placementEvaluationCap,
          consumedPlacementEvaluations,
          perDepthBudgetLedgers,
          noSkipFrontier,
          counters,
          producerRole,
          schedulerDeficit: input.schedulerDeficit ?? 0,
          sheetWidthGrid,
          sheetHeightGrid
        })
        const totalMs = Math.max(0, performance.now() - startedAt)
        return {
          status: 'paused',
          endpoints: [],
          trace: makeIntrinsicCapacitySearchTrace({
            coldBeamWidth,
            localLegalPlacementFanout,
            placementEvaluationCap,
            placementEvaluationQuotaPerDepth,
            consumedPlacementEvaluations,
            counters,
            pieceCount: input.preparedPieces.length,
            settlement: 'paused',
            topologyRetentionDepths
          }),
          phaseTimings: capture ? { ...timings, totalMs } : undefined,
          checkpoint
        }
      }
    }

    const materializationStartedAt = capture ? performance.now() : 0
    const endpointsByHash = new Map<string, IntrinsicCapacityEndpoint>()
    for (const entry of beam) {
      const placedIdSet = new Set(entry.state.placementOrder)
      const unplacedPreparedIds = preparedIds.filter((id) => !placedIdSet.has(id))
      const endpoint = materializeIntrinsicCapacityEndpoint({
        sheet: input.sheet,
        state: entry.state,
        unplacedPreparedIds,
        origin:
          producerRole === 'capacity-warm-prefix'
            ? 'warm-prefix-continuation'
            : 'cold-search',
        ...(input.warmPrefixSeed === undefined
          ? {}
          : {
              sourceRole: input.warmPrefixSeed.sourceRole,
              prefixDepth: input.warmPrefixSeed.depth
            }),
        materialAreasByPieceId: input.materialAreasByPieceId,
        cavityCache: input.cavityCache
      })
      if (endpoint === undefined) {
        endpointFitRejections += 1
        continue
      }
      const existing = endpointsByHash.get(endpoint.canonicalGeometryHash)
      if (existing === undefined || compareIntrinsicCapacityEndpoints(endpoint, existing) < 0) {
        endpointsByHash.set(endpoint.canonicalGeometryHash, endpoint)
      }
    }
    const endpoints = [...endpointsByHash.values()].toSorted(compareIntrinsicCapacityEndpoints)
    if (capture) {
      timings.endpointMaterializationMs += performance.now() - materializationStartedAt
    }

    const totalMs = Math.max(0, performance.now() - startedAt)
    const counters = capacitySearchCounters({
      prunedByAttainableCount,
      prunedByAttainableMaterial,
      deduplicatedSuccessors,
      fitRejectedCandidates,
      invalidCandidates,
      endpointFitRejections,
      completedDepths,
      depthQuotaExhaustions
    })
    return {
      status: 'settled',
      endpoints,
      trace: makeIntrinsicCapacitySearchTrace({
        coldBeamWidth,
        localLegalPlacementFanout,
        placementEvaluationCap,
        placementEvaluationQuotaPerDepth,
        consumedPlacementEvaluations,
        counters,
        pieceCount: input.preparedPieces.length,
        settlement,
        topologyRetentionDepths
      }),
      phaseTimings: capture ? { ...timings, totalMs } : undefined,
      checkpoint: undefined
    }
  })
}

/**
 * Materializes exact best-known endpoints from one paused protected lane.
 * Pending work is reported honestly as unplaced; the checkpoint itself remains
 * resumable and unchanged.
 */
export function materializeIntrinsicCapacityCheckpointEndpoints(input: {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly materialAreasByPieceId: ReadonlyMap<PieceId, bigint>
  readonly cavityCache: IntrinsicCapacityCavityCache
  readonly checkpoint: IntrinsicAnytimeCheckpoint
  readonly warmPrefixSeed?: IntrinsicCapacityWarmPrefixSeed
}): ReadonlyArray<IntrinsicCapacityEndpoint> {
  const preparedIds = input.preparedPieces.map(intrinsicCapacityPreparedPieceId)
  const endpointsByHash = new Map<string, IntrinsicCapacityEndpoint>()
  for (const entry of input.checkpoint.frontier) {
    const placedIdSet = new Set(entry.state.placementOrder)
    const unplacedPreparedIds = preparedIds.filter((pieceId) => !placedIdSet.has(pieceId))
    const endpoint = materializeIntrinsicCapacityEndpoint({
      sheet: input.sheet,
      state: entry.state,
      unplacedPreparedIds,
      origin:
        input.checkpoint.producerRole === 'capacity-warm-prefix'
          ? 'warm-prefix-continuation'
          : 'cold-search',
      ...(input.warmPrefixSeed === undefined
        ? {}
        : {
            sourceRole: input.warmPrefixSeed.sourceRole,
            prefixDepth: input.warmPrefixSeed.depth
          }),
      materialAreasByPieceId: input.materialAreasByPieceId,
      cavityCache: input.cavityCache
    })
    if (endpoint === undefined) continue
    const existing = endpointsByHash.get(endpoint.canonicalGeometryHash)
    if (existing === undefined || compareIntrinsicCapacityEndpoints(endpoint, existing) < 0) {
      endpointsByHash.set(endpoint.canonicalGeometryHash, endpoint)
    }
  }
  return [...endpointsByHash.values()].toSorted(compareIntrinsicCapacityEndpoints)
}

function capacitySearchCounters(
  counters: IntrinsicCapacitySearchCounters
): IntrinsicCapacitySearchCounters {
  return counters
}

function makeIntrinsicCapacitySearchTrace(input: {
  readonly coldBeamWidth: number
  readonly localLegalPlacementFanout: number
  readonly placementEvaluationCap: number
  readonly placementEvaluationQuotaPerDepth: number
  readonly consumedPlacementEvaluations: number
  readonly counters: IntrinsicCapacitySearchCounters
  readonly pieceCount: number
  readonly settlement: IntrinsicCapacitySettlement
  readonly topologyRetentionDepths: ReadonlyArray<IntrinsicCapacityTopologyRetentionDepthTrace>
}): IntrinsicCapacitySearchTrace {
  return {
    beamWidth: input.coldBeamWidth,
    localLegalPlacementFanout: input.localLegalPlacementFanout,
    placementEvaluationCap: input.placementEvaluationCap,
    placementEvaluationQuotaPerDepth: input.placementEvaluationQuotaPerDepth,
    consumedPlacementEvaluations: input.consumedPlacementEvaluations,
    auxiliaryPlacementEvaluations: 0,
    ...input.counters,
    pieceCount: input.pieceCount,
    settlement: input.settlement,
    topologyRetentionDepths:
      input.topologyRetentionDepths.length === 0
        ? undefined
        : input.topologyRetentionDepths
  }
}

type WarmPrefixValidation =
  | {
      readonly kind: 'valid'
      readonly entry:
        | {
            readonly depth: number
            readonly beamEntry: CapacityBeamEntry
          }
        | undefined
    }
  | { readonly kind: 'invalid'; readonly message: string }

function validateWarmPrefixSeed(input: {
  readonly seed: IntrinsicCapacityWarmPrefixSeed | undefined
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly preparedIds: ReadonlyArray<PieceId>
  readonly materialAreasByPieceId: ReadonlyMap<PieceId, bigint>
  readonly cavityCache: IntrinsicCapacityCavityCache
  readonly sheetWidthGrid: number
  readonly sheetHeightGrid: number
}): WarmPrefixValidation {
  const seed = input.seed
  if (seed === undefined) return { kind: 'valid', entry: undefined }
  if (
    seed.sourceRole.length === 0 ||
    !Number.isSafeInteger(seed.depth) ||
    seed.depth <= 0 ||
    seed.depth >= input.preparedPieces.length
  ) {
    return { kind: 'invalid', message: 'warm prefix role or depth is invalid.' }
  }
  const expectedPlacedIds = input.preparedIds.slice(0, seed.depth)
  const expectedPendingIds = input.preparedIds.slice(seed.depth)
  const statePendingIds = seed.state.remainingPreparedPieces.map(
    intrinsicCapacityPreparedPieceId
  )
  if (
    seed.state.unplacedPieceIds.length !== 0 ||
    !equalPieceIdArrays(seed.state.placementOrder, expectedPlacedIds) ||
    !equalPieceIdArrays(statePendingIds, expectedPendingIds)
  ) {
    return {
      kind: 'invalid',
      message: 'warm prefix must be an exact skip-free prefix of the prepared order.'
    }
  }
  let placedDoubledMaterialAreaGrid2 = 0n
  for (const pieceId of expectedPlacedIds) {
    const area = input.materialAreasByPieceId.get(pieceId)
    if (area === undefined) {
      return { kind: 'invalid', message: `warm prefix piece ${pieceId} has no material area.` }
    }
    placedDoubledMaterialAreaGrid2 += area
  }
  const gridSpan = intrinsicCapacityStateGridSpan(seed.state)
  if (gridSpan === undefined) {
    return { kind: 'invalid', message: 'warm prefix has no exact occupied span.' }
  }
  const fitMask = intrinsicCapacitySpanFitsSheet(
    gridSpan,
    input.sheetWidthGrid,
    input.sheetHeightGrid
  )
  if (!fitMask.q0 && !fitMask.q90) {
    return { kind: 'invalid', message: 'warm prefix does not fit the requested sheet.' }
  }
  const anchoredOccupiedKey = seed.state.bottomLeftAnchoredCanonicalOccupiedGeometryKey()
  if (anchoredOccupiedKey === undefined) {
    return { kind: 'invalid', message: 'warm prefix has no anchored occupied identity.' }
  }
  const cavities = measureIntrinsicCapacityCavities(seed.state, input.cavityCache)
  if (cavities === undefined) {
    return { kind: 'invalid', message: 'warm prefix cavity measurement failed.' }
  }
  return {
    kind: 'valid',
    entry: {
      depth: seed.depth,
      beamEntry: {
        state: seed.state,
        placedDoubledMaterialAreaGrid2,
        anchoredOccupiedKey,
        gridSpan,
        cavities
      }
    }
  }
}

function makeIntrinsicCapacityCheckpoint(input: {
  readonly requestFingerprint: string
  readonly incumbentBinding: IntrinsicAnytimeIncumbentBinding | undefined
  readonly beam: ReadonlyArray<CapacityBeamEntry>
  readonly preparedIds: ReadonlyArray<PieceId>
  readonly nextDepth: number
  readonly placementEvaluationCap: number
  readonly consumedPlacementEvaluations: number
  readonly perDepthBudgetLedgers: ReadonlyArray<IntrinsicAnytimeDepthBudgetLedger>
  readonly noSkipFrontier: IntrinsicAnytimeNoSkipFrontierState
  readonly counters: IntrinsicCapacitySearchCounters
  readonly producerRole:
    | 'capacity-cold'
    | 'capacity-cohesion-shadow'
    | 'capacity-warm-prefix'
  readonly schedulerDeficit: number
  readonly sheetWidthGrid: number
  readonly sheetHeightGrid: number
}): IntrinsicAnytimeCheckpoint {
  const pendingPreparedIds = input.preparedIds.slice(input.nextDepth)
  const checkpointWithoutIntegrity: Omit<IntrinsicAnytimeCheckpoint, 'integrityHash'> = {
    version: INTRINSIC_ANYTIME_CHECKPOINT_VERSION,
    requestFingerprint: input.requestFingerprint,
    producerRole: input.producerRole,
    archiveCohort: 'partial',
    searchBounds: INTRINSIC_CAPACITY_V1_BOUNDS,
    incumbentBinding: input.incumbentBinding,
    frontier: input.beam.map((entry) => {
      const permanentlySkippedPreparedIds = [...entry.state.unplacedPieceIds]
      const fitMask = intrinsicCapacitySpanFitsSheet(
        entry.gridSpan,
        input.sheetWidthGrid,
        input.sheetHeightGrid
      )
      return {
        state: entry.state,
        continuationMetadataIdentity: entry.state.continuationMetadataIdentity(),
        eligibility:
          permanentlySkippedPreparedIds.length === 0 ? 'completeEligible' : 'subsetOnly',
        placedPreparedIds: [...entry.state.placementOrder],
        pendingPreparedIds,
        deferredPreparedIds: [],
        permanentlySkippedPreparedIds,
        pendingOrder: pendingPreparedIds,
        cursor: input.nextDepth,
        pass: 0,
        deferralCounts: {},
        placedDoubledMaterialAreaGrid2: entry.placedDoubledMaterialAreaGrid2,
        cavities: entry.cavities,
        anchoredOccupiedKey: entry.anchoredOccupiedKey,
        gridSpan: entry.gridSpan,
        fitMask
      }
    }),
    nextDepth: input.nextDepth,
    depthBoundaryResumePosition: input.nextDepth,
    budgetLedgers: {
      totalPlacementEvaluationCap: input.placementEvaluationCap,
      totalConsumedPlacementEvaluations: input.consumedPlacementEvaluations,
      perDepth: input.perDepthBudgetLedgers,
      perCohort: {
        complete: 0,
        partial: input.consumedPlacementEvaluations,
        experimentalComplete: 0
      }
    },
    schedulerDeficit: input.schedulerDeficit,
    settlement: 'active',
    censoring: 'none',
    noSkipFrontier: input.noSkipFrontier,
    counters: input.counters
  }
  return {
    ...checkpointWithoutIntegrity,
    integrityHash: intrinsicCapacityCheckpointIntegrityHash(checkpointWithoutIntegrity)
  }
}

function validateIntrinsicCapacityCheckpoint(input: {
  readonly checkpoint: IntrinsicAnytimeCheckpoint
  readonly requestFingerprint: string
  readonly incumbentBinding: IntrinsicAnytimeIncumbentBinding | undefined
  readonly producerRole:
    | 'capacity-cold'
    | 'capacity-cohesion-shadow'
    | 'capacity-warm-prefix'
  readonly schedulerDeficit: number
  readonly preparedIds: ReadonlyArray<PieceId>
  readonly materialAreasByPieceId: ReadonlyMap<PieceId, bigint>
  readonly placementEvaluationCap: number
  readonly sheetWidthGrid: number
  readonly sheetHeightGrid: number
}): string | undefined {
  const { checkpoint } = input
  if (checkpoint.version !== INTRINSIC_ANYTIME_CHECKPOINT_VERSION) {
    return `unsupported checkpoint version ${checkpoint.version}.`
  }
  const expectedIntegrityHash = intrinsicCapacityCheckpointIntegrityHash({
    version: checkpoint.version,
    requestFingerprint: checkpoint.requestFingerprint,
    producerRole: checkpoint.producerRole,
    archiveCohort: checkpoint.archiveCohort,
    searchBounds: checkpoint.searchBounds,
    incumbentBinding: checkpoint.incumbentBinding,
    frontier: checkpoint.frontier,
    nextDepth: checkpoint.nextDepth,
    depthBoundaryResumePosition: checkpoint.depthBoundaryResumePosition,
    budgetLedgers: checkpoint.budgetLedgers,
    schedulerDeficit: checkpoint.schedulerDeficit,
    settlement: checkpoint.settlement,
    censoring: checkpoint.censoring,
    noSkipFrontier: checkpoint.noSkipFrontier,
    counters: checkpoint.counters
  })
  if (checkpoint.integrityHash !== expectedIntegrityHash) {
    return 'checkpoint integrity hash does not match its retained frontier.'
  }
  if (checkpoint.requestFingerprint !== input.requestFingerprint) {
    return 'checkpoint request/prepared-order fingerprint does not match the current request.'
  }
  if (
    checkpoint.producerRole !== input.producerRole ||
    checkpoint.archiveCohort !== 'partial'
  ) {
    return `capacity search requires a ${input.producerRole} partial-cohort checkpoint.`
  }
  if (
    canonicalJson(checkpoint.searchBounds) !== canonicalJson(INTRINSIC_CAPACITY_V1_BOUNDS)
  ) {
    return 'checkpoint search bounds do not match the current capacity implementation.'
  }
  if (
    canonicalJson(checkpoint.incumbentBinding) !== canonicalJson(input.incumbentBinding)
  ) {
    return 'checkpoint pruning incumbent does not match the current resume request.'
  }
  if (
    !Number.isSafeInteger(checkpoint.nextDepth) ||
    checkpoint.nextDepth <= 0 ||
    checkpoint.nextDepth >= input.preparedIds.length ||
    checkpoint.depthBoundaryResumePosition !== checkpoint.nextDepth
  ) {
    return 'checkpoint is not positioned at a valid completed depth boundary.'
  }
  if (checkpoint.frontier.length === 0) return 'checkpoint frontier must not be empty.'
  if (
    checkpoint.budgetLedgers.totalPlacementEvaluationCap !== input.placementEvaluationCap ||
    checkpoint.budgetLedgers.totalConsumedPlacementEvaluations < 0 ||
    checkpoint.budgetLedgers.totalConsumedPlacementEvaluations >
      checkpoint.budgetLedgers.totalPlacementEvaluationCap
  ) {
    return 'checkpoint total budget ledger is invalid for the current request.'
  }
  if (
    checkpoint.budgetLedgers.perDepth.length !== checkpoint.nextDepth ||
    checkpoint.budgetLedgers.perDepth.some(
      (ledger, index) =>
        ledger.depth !== index ||
        !Number.isSafeInteger(ledger.consumedPlacementEvaluations) ||
        ledger.consumedPlacementEvaluations < 0 ||
        ledger.consumedPlacementEvaluations >
          INTRINSIC_CAPACITY_V1_BOUNDS.placementEvaluationQuotaPerDepth ||
        (ledger.quotaExhausted &&
          ledger.consumedPlacementEvaluations !==
            INTRINSIC_CAPACITY_V1_BOUNDS.placementEvaluationQuotaPerDepth)
    )
  ) {
    return 'checkpoint per-depth budget ledger is not contiguous or exceeds its quota.'
  }
  const consumedFromDepths = checkpoint.budgetLedgers.perDepth.reduce(
    (sum, ledger) => sum + ledger.consumedPlacementEvaluations,
    0
  )
  if (
    consumedFromDepths !== checkpoint.budgetLedgers.totalConsumedPlacementEvaluations ||
    checkpoint.budgetLedgers.perCohort.partial !== consumedFromDepths ||
    checkpoint.budgetLedgers.perCohort.complete !== 0 ||
    checkpoint.budgetLedgers.perCohort.experimentalComplete !== 0
  ) {
    return 'checkpoint total, per-depth, and per-cohort budget ledgers disagree.'
  }
  if (
    !Number.isSafeInteger(checkpoint.schedulerDeficit) ||
    checkpoint.schedulerDeficit < 0 ||
    checkpoint.schedulerDeficit !== input.schedulerDeficit ||
    checkpoint.settlement !== 'active' ||
    checkpoint.censoring !== 'none' ||
    checkpoint.counters.completedDepths !== checkpoint.nextDepth ||
    checkpoint.counters.depthQuotaExhaustions !==
      checkpoint.budgetLedgers.perDepth.filter(({ quotaExhausted }) => quotaExhausted).length ||
    !Object.values(checkpoint.counters).every(isNonNegativeSafeInteger)
  ) {
    return 'checkpoint scheduler or settlement state is invalid for a cold depth-boundary resume.'
  }
  if (
    checkpoint.noSkipFrontier.present
      ? checkpoint.noSkipFrontier.firstLossDepth !== undefined
      : checkpoint.noSkipFrontier.firstLossDepth === undefined ||
        !Number.isSafeInteger(checkpoint.noSkipFrontier.firstLossDepth) ||
        checkpoint.noSkipFrontier.firstLossDepth < 1 ||
        checkpoint.noSkipFrontier.firstLossDepth > checkpoint.nextDepth
  ) {
    return 'checkpoint no-skip-frontier loss depth is invalid for its resume boundary.'
  }

  const expectedPendingIds = input.preparedIds.slice(checkpoint.nextDepth)
  const validationCavityCache: IntrinsicCapacityCavityCache = new Map()
  let hasNoSkipState = false
  for (const entry of checkpoint.frontier) {
    const statePlacedIds = [...entry.state.placementOrder]
    const statePendingIds = entry.state.remainingPreparedPieces.map(
      intrinsicCapacityPreparedPieceId
    )
    const stateSkippedIds = [...entry.state.unplacedPieceIds]
    if (
      entry.continuationMetadataIdentity !==
      entry.state.continuationMetadataIdentity()
    ) {
      return 'checkpoint continuation metadata identity does not match its beam state.'
    }
    const recomputedState = new IrregularBeamState({
      remainingPreparedPieces: entry.state.remainingPreparedPieces,
      placedCollisionGeometries: entry.state.placedCollisionGeometries,
      unplacedPieceIds: entry.state.unplacedPieceIds,
      placementOrder: entry.state.placementOrder,
      ...(entry.state.parent === undefined ? {} : { parent: entry.state.parent })
    })
    if (
      recomputedState.canonicalEntryContinuationIdentity() !==
      entry.state.canonicalEntryContinuationIdentity()
    ) {
      return 'checkpoint canonical-entry cache is inconsistent.'
    }
    if (
      recomputedState.placedCollisionIndex.continuationIdentity() !==
      entry.state.placedCollisionIndex.continuationIdentity() ||
      !entry.state.placedCollisionIndex.matches(
        entry.state.placedCollisionGeometries
      )
    ) {
      return 'checkpoint spatial-index cache is inconsistent.'
    }
    if (
      !equalPieceIdArrays(entry.placedPreparedIds, statePlacedIds) ||
      !equalPieceIdArrays(entry.pendingPreparedIds, expectedPendingIds) ||
      !equalPieceIdArrays(entry.pendingOrder, expectedPendingIds) ||
      !equalPieceIdArrays(statePendingIds, expectedPendingIds) ||
      !equalPieceIdArrays(entry.permanentlySkippedPreparedIds, stateSkippedIds) ||
      entry.deferredPreparedIds.length !== 0 ||
      entry.cursor !== checkpoint.nextDepth ||
      entry.pass !== 0 ||
      Object.keys(entry.deferralCounts).length !== 0
    ) {
      return 'checkpoint future-decision state does not match its beam geometry payload.'
    }
    const partition = [
      ...entry.placedPreparedIds,
      ...entry.pendingPreparedIds,
      ...entry.deferredPreparedIds,
      ...entry.permanentlySkippedPreparedIds
    ]
    if (
      new Set(partition).size !== partition.length ||
      !equalPieceIdArrays(
        [...partition].toSorted(compareStrings),
        [...input.preparedIds].toSorted(compareStrings)
      )
    ) {
      return 'checkpoint placed, pending, deferred, and skipped IDs are not a disjoint request partition.'
    }
    const eligibility = stateSkippedIds.length === 0 ? 'completeEligible' : 'subsetOnly'
    if (entry.eligibility !== eligibility) {
      return 'checkpoint complete eligibility disagrees with permanent-skip accounting.'
    }
    hasNoSkipState ||= eligibility === 'completeEligible'
    const expectedMaterial = statePlacedIds.reduce<bigint | undefined>((sum, pieceId) => {
      const area = input.materialAreasByPieceId.get(pieceId)
      return sum === undefined || area === undefined ? undefined : sum + area
    }, 0n)
    if (
      expectedMaterial === undefined ||
      expectedMaterial !== entry.placedDoubledMaterialAreaGrid2
    ) {
      return 'checkpoint placed-material accounting is invalid.'
    }
    const gridSpan = intrinsicCapacityStateGridSpan(entry.state)
    if (
      gridSpan === undefined ||
      gridSpan.widthGrid !== entry.gridSpan.widthGrid ||
      gridSpan.heightGrid !== entry.gridSpan.heightGrid
    ) {
      return 'checkpoint exact occupied span does not match its geometry payload.'
    }
    const fitMask = intrinsicCapacitySpanFitsSheet(
      gridSpan,
      input.sheetWidthGrid,
      input.sheetHeightGrid
    )
    if (fitMask.q0 !== entry.fitMask.q0 || fitMask.q90 !== entry.fitMask.q90) {
      return 'checkpoint q0/q90 fit mask does not match its exact occupied span.'
    }
    const anchoredOccupiedKey =
      entry.state.bottomLeftAnchoredCanonicalOccupiedGeometryKey() ??
      entry.state.canonicalOccupiedGeometryKey
    if (anchoredOccupiedKey !== entry.anchoredOccupiedKey) {
      return 'checkpoint anchored occupied identity does not match its geometry payload.'
    }
    const cavities = measureIntrinsicCapacityCavities(entry.state, validationCavityCache)
    if (
      cavities === undefined ||
      cavities.count !== entry.cavities.count ||
      cavities.totalAreaMm2 !== entry.cavities.totalAreaMm2
    ) {
      return 'checkpoint cavity objective does not match its exact geometry payload.'
    }
  }
  if (
    checkpoint.noSkipFrontier.present !== hasNoSkipState ||
    (hasNoSkipState && checkpoint.noSkipFrontier.firstLossDepth !== undefined)
  ) {
    return 'checkpoint no-skip-frontier state disagrees with the retained frontier.'
  }
  return undefined
}

function intrinsicCapacityCheckpointIntegrityHash(
  checkpoint: Omit<IntrinsicAnytimeCheckpoint, 'integrityHash'>
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        version: checkpoint.version,
        requestFingerprint: checkpoint.requestFingerprint,
        producerRole: checkpoint.producerRole,
        archiveCohort: checkpoint.archiveCohort,
        searchBounds: checkpoint.searchBounds,
        incumbentBinding: checkpoint.incumbentBinding,
        frontier: checkpoint.frontier.map((entry) => ({
          state: {
            pendingIds: entry.state.remainingPreparedPieces.map(
              intrinsicCapacityPreparedPieceId
            ),
            placedIds: entry.state.placedCollisionGeometries.map(
              ({ placement }) => placement.pieceId ?? placement.sourcePieceId
            ),
            unplacedIds: entry.state.unplacedPieceIds,
            placementOrder: entry.state.placementOrder,
            canonicalOccupiedGeometryKey:
              entry.state.canonicalOccupiedGeometryKey,
            translatedCollisionBounds: entry.state.translatedCollisionBounds,
            sharedCollisionBoundaryLengthMm:
              entry.state.sharedCollisionBoundaryLengthMm,
            sharedCollisionBoundaryContactUnits:
              entry.state.sharedCollisionBoundaryContactUnits,
            nearCompleteStructuralContactCount:
              entry.state.nearCompleteStructuralContactCount,
            dominantNearCompleteStructuralContactCount:
              entry.state.dominantNearCompleteStructuralContactCount,
            continuationMetadataIdentity:
              entry.state.continuationMetadataIdentity()
          },
          continuationMetadataIdentity: entry.continuationMetadataIdentity,
          eligibility: entry.eligibility,
          placedPreparedIds: entry.placedPreparedIds,
          pendingPreparedIds: entry.pendingPreparedIds,
          deferredPreparedIds: entry.deferredPreparedIds,
          permanentlySkippedPreparedIds:
            entry.permanentlySkippedPreparedIds,
          pendingOrder: entry.pendingOrder,
          cursor: entry.cursor,
          pass: entry.pass,
          deferralCounts: entry.deferralCounts,
          placedDoubledMaterialAreaGrid2:
            entry.placedDoubledMaterialAreaGrid2,
          cavities: entry.cavities,
          anchoredOccupiedKey: entry.anchoredOccupiedKey,
          gridSpan: entry.gridSpan,
          fitMask: entry.fitMask
        })),
        nextDepth: checkpoint.nextDepth,
        depthBoundaryResumePosition: checkpoint.depthBoundaryResumePosition,
        budgetLedgers: checkpoint.budgetLedgers,
        schedulerDeficit: checkpoint.schedulerDeficit,
        settlement: checkpoint.settlement,
        censoring: checkpoint.censoring,
        noSkipFrontier: checkpoint.noSkipFrontier,
        counters: checkpoint.counters
      })
    )
    .digest('hex')
}

function intrinsicCapacityRequestFingerprint(input: {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly materialAreasByPieceId: ReadonlyMap<PieceId, bigint>
  readonly incumbent?: IntrinsicCapacityEndpoint
  readonly warmPrefixSeed?: IntrinsicCapacityWarmPrefixSeed
  readonly schedulerDeficit?: number
  readonly retentionMode?: IntrinsicCapacityRetentionMode
}): string {
  const material = [...input.materialAreasByPieceId.entries()]
    .map(([pieceId, area]) => [pieceId, area] as const)
    .toSorted(([firstId], [secondId]) => compareStrings(firstId, secondId))
  return createHash('sha256')
    .update(
      canonicalJson({
        version: INTRINSIC_ANYTIME_CHECKPOINT_VERSION,
        searchBounds: INTRINSIC_CAPACITY_V1_BOUNDS,
        sheet: input.sheet,
        preparedPieces: input.preparedPieces,
        material,
        incumbent: intrinsicCapacityIncumbentBinding(input.incumbent),
        schedulerDeficit: input.schedulerDeficit ?? 0,
        retentionMode: input.retentionMode ?? 'objective',
        warmPrefix:
          input.warmPrefixSeed === undefined
            ? undefined
            : {
                sourceRole: input.warmPrefixSeed.sourceRole,
                depth: input.warmPrefixSeed.depth,
                placedPreparedIds: input.warmPrefixSeed.state.placementOrder,
                pendingPreparedIds: input.warmPrefixSeed.state.remainingPreparedPieces.map(
                  intrinsicCapacityPreparedPieceId
                ),
                anchoredOccupiedKey:
                  input.warmPrefixSeed.state.bottomLeftAnchoredCanonicalOccupiedGeometryKey()
              }
      })
    )
    .digest('hex')
}

function intrinsicCapacityIncumbentBinding(
  incumbent: IntrinsicCapacityEndpoint | undefined
): IntrinsicAnytimeIncumbentBinding | undefined {
  return incumbent === undefined
    ? undefined
    : {
        canonicalGeometryHash: incumbent.canonicalGeometryHash,
        placedCount: incumbent.metrics.placedCount,
        placedDoubledMaterialAreaGrid2: incumbent.metrics.placedDoubledMaterialAreaGrid2,
        origin: incumbent.origin,
        selectedRotationDeg: incumbent.selectedRotationDeg
      }
}

function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const fields = Object.entries(value)
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .toSorted(([firstKey], [secondKey]) => compareStrings(firstKey, secondKey))
    .map(([key, fieldValue]) => `${JSON.stringify(key)}:${canonicalJson(fieldValue)}`)
  return `{${fields.join(',')}}`
}

function equalPieceIdArrays(
  first: ReadonlyArray<PieceId>,
  second: ReadonlyArray<PieceId>
): boolean {
  return first.length === second.length && first.every((pieceId, index) => pieceId === second[index])
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function pushSuccessor(
  successors: CapacityBeamEntry[],
  successorKeys: Set<string>,
  successor: CapacityBeamEntry,
  onDuplicate: () => void
): boolean {
  const successorKey = intrinsicCapacitySuccessorIdentity(successor)
  if (successorKeys.has(successorKey)) {
    onDuplicate()
    return false
  }
  successorKeys.add(successorKey)
  successors.push(successor)
  return true
}

/** Future-equivalent identity at one synchronized prepared-piece depth. */
function intrinsicCapacitySuccessorIdentity(successor: CapacityBeamEntry): string {
  return `${successor.anchoredOccupiedKey}|placed=${JSON.stringify(
    [...successor.state.placementOrder].toSorted(compareStrings)
  )}`
}

interface EvaluatedCandidateReference extends ScoredCandidateReference {
  readonly widthGrid: number
  readonly heightGrid: number
  readonly sharedBoundaryLengthMm?: number
}

/**
 * Cheap exact candidate evaluation from incrementally derived occupied bounds.
 * No placement object, beam state, spatial index, contact measurement, or
 * anchored rebuild is constructed for candidates that are not selected.
 */
function evaluateCandidate(
  entry: CapacityBeamEntry,
  moving: TransformedCollisionGeometry,
  candidate: IrregularPlacementCandidate,
  transformOrdinal: number
): EvaluatedCandidateReference | undefined {
  const parentBounds = entry.state.translatedCollisionBounds
  if (parentBounds === undefined) return undefined
  const movingMinX = moving.bounds.minX + candidate.point.x
  const movingMinY = moving.bounds.minY + candidate.point.y
  const movingMaxX = moving.bounds.maxX + candidate.point.x
  const movingMaxY = moving.bounds.maxY + candidate.point.y
  const isFirstPlacement = entry.state.placedCollisionGeometries.length === 0
  const minX = isFirstPlacement ? movingMinX : Math.min(parentBounds.minX, movingMinX)
  const minY = isFirstPlacement ? movingMinY : Math.min(parentBounds.minY, movingMinY)
  const maxX = isFirstPlacement ? movingMaxX : Math.max(parentBounds.maxX, movingMaxX)
  const maxY = isFirstPlacement ? movingMaxY : Math.max(parentBounds.maxY, movingMaxY)
  const minXGrid = toGridMm(minX)
  const minYGrid = toGridMm(minY)
  const maxXGrid = toGridMm(maxX)
  const maxYGrid = toGridMm(maxY)
  const gridX = toGridMm(candidate.point.x)
  const gridY = toGridMm(candidate.point.y)
  if (
    minXGrid === undefined ||
    minYGrid === undefined ||
    maxXGrid === undefined ||
    maxYGrid === undefined ||
    gridX === undefined ||
    gridY === undefined
  ) {
    return undefined
  }
  const widthGrid = maxXGrid - minXGrid
  const heightGrid = maxYGrid - minYGrid
  return {
    moving,
    candidate,
    maximumSideGrid: Math.max(widthGrid, heightGrid),
    envelopeAreaGrid2: widthGrid * heightGrid,
    envelopeSpanGrid: widthGrid + heightGrid,
    transformOrdinal,
    gridX,
    gridY,
    widthGrid,
    heightGrid
  }
}

function compareScoredCandidateReferences(
  first: ScoredCandidateReference,
  second: ScoredCandidateReference
): number {
  return (
    first.maximumSideGrid - second.maximumSideGrid ||
    first.envelopeAreaGrid2 - second.envelopeAreaGrid2 ||
    first.envelopeSpanGrid - second.envelopeSpanGrid ||
    first.transformOrdinal - second.transformOrdinal ||
    first.gridX - second.gridX ||
    first.gridY - second.gridY
  )
}

function compareContactCandidateReferences(
  first: EvaluatedCandidateReference,
  second: EvaluatedCandidateReference
): number {
  return (
    (second.sharedBoundaryLengthMm ?? 0) -
      (first.sharedBoundaryLengthMm ?? 0) ||
    compareScoredCandidateReferences(first, second)
  )
}

function capacityCandidateReferenceIdentity(
  reference: EvaluatedCandidateReference
): string {
  return `${reference.candidate.transform.index}:${reference.gridX}:${reference.gridY}`
}

/**
 * Within one depth the capacity retention order mirrors the endpoint
 * objective: count, exact material, exact cavities, then intrinsic envelope
 * compactness and deterministic occupied identity. Depths never compete.
 */
function compareCapacityBeamEntries(first: CapacityBeamEntry, second: CapacityBeamEntry): number {
  const firstCount = first.state.placementOrder.length
  const secondCount = second.state.placementOrder.length
  if (firstCount !== secondCount) return secondCount - firstCount
  if (first.placedDoubledMaterialAreaGrid2 !== second.placedDoubledMaterialAreaGrid2) {
    return first.placedDoubledMaterialAreaGrid2 > second.placedDoubledMaterialAreaGrid2 ? -1 : 1
  }
  return (
    first.cavities.count - second.cavities.count ||
    Math.round(first.cavities.totalAreaMm2 * 1_000_000) -
      Math.round(second.cavities.totalAreaMm2 * 1_000_000) ||
    Math.max(first.gridSpan.widthGrid, first.gridSpan.heightGrid) -
      Math.max(second.gridSpan.widthGrid, second.gridSpan.heightGrid) ||
    first.gridSpan.widthGrid * first.gridSpan.heightGrid -
      second.gridSpan.widthGrid * second.gridSpan.heightGrid ||
    first.gridSpan.widthGrid +
      first.gridSpan.heightGrid -
      (second.gridSpan.widthGrid + second.gridSpan.heightGrid) ||
    compareStrings(first.anchoredOccupiedKey, second.anchoredOccupiedKey)
  )
}

function compareCapacityBeamEntriesAreaFirst(
  first: CapacityBeamEntry,
  second: CapacityBeamEntry
): number {
  const firstCount = first.state.placementOrder.length
  const secondCount = second.state.placementOrder.length
  if (firstCount !== secondCount) return secondCount - firstCount
  if (first.placedDoubledMaterialAreaGrid2 !== second.placedDoubledMaterialAreaGrid2) {
    return first.placedDoubledMaterialAreaGrid2 > second.placedDoubledMaterialAreaGrid2 ? -1 : 1
  }
  return (
    first.cavities.count - second.cavities.count ||
    Math.round(first.cavities.totalAreaMm2 * 1_000_000) -
      Math.round(second.cavities.totalAreaMm2 * 1_000_000) ||
    first.gridSpan.widthGrid * first.gridSpan.heightGrid -
      second.gridSpan.widthGrid * second.gridSpan.heightGrid ||
    Math.max(first.gridSpan.widthGrid, first.gridSpan.heightGrid) -
      Math.max(second.gridSpan.widthGrid, second.gridSpan.heightGrid) ||
    first.gridSpan.widthGrid +
      first.gridSpan.heightGrid -
      (second.gridSpan.widthGrid + second.gridSpan.heightGrid) ||
    compareStrings(first.anchoredOccupiedKey, second.anchoredOccupiedKey)
  )
}

function retainCapacityBeamEntries(
  entries: ReadonlyArray<CapacityBeamEntry>,
  beamWidth: number,
  mode: IntrinsicCapacityRetentionMode,
  topologyMeasurements?: CapacityTopologyMeasurements
): ReadonlyArray<CapacityBeamEntry> {
  if (mode === 'objective') {
    return entries.toSorted(compareCapacityBeamEntries).slice(0, beamWidth)
  }
  if (mode === 'area-first-shadow') {
    return entries.toSorted(compareCapacityBeamEntriesAreaFirst).slice(0, beamWidth)
  }
  if (mode === 'cohesion-frontier-shadow') {
    return retainCapacityCohesionFrontier(
      entries,
      beamWidth,
      topologyMeasurements ?? makeCapacityTopologyMeasurements()
    )
  }

  const retained: CapacityBeamEntry[] = []
  const retainedKeys = new Set<string>()
  const reserve = (
    ordered: ReadonlyArray<CapacityBeamEntry>,
    maximum: number
  ): void => {
    let added = 0
    for (const entry of ordered) {
      if (retained.length >= beamWidth) return
      const key = intrinsicCapacitySuccessorIdentity(entry)
      if (retainedKeys.has(key)) continue
      retained.push(entry)
      retainedKeys.add(key)
      added += 1
      if (added >= maximum || retained.length >= beamWidth) return
    }
  }
  reserve(entries.toSorted(compareCapacityBeamEntries), Math.max(1, beamWidth - 8))
  reserve(entries.toSorted(compareCapacityBeamEntriesWidthFirst), 4)
  reserve(entries.toSorted(compareCapacityBeamEntriesHeightFirst), 4)
  reserve(entries.toSorted(compareCapacityBeamEntries), beamWidth)
  return retained
}

function retainCapacityCohesionFrontier(
  entries: ReadonlyArray<CapacityBeamEntry>,
  beamWidth: number,
  topologyMeasurements: CapacityTopologyMeasurements
): ReadonlyArray<CapacityBeamEntry> {
  const compareTopology = (
    first: CapacityBeamEntry,
    second: CapacityBeamEntry,
    metric:
      | 'isolated'
      | 'largest-component'
      | 'component-count'
      | 'hull-waste'
  ): number => {
    const accounting = compareCapacityBeamEntryAccounting(first, second)
    if (accounting !== 0) return accounting
    const firstTopology = topologyMeasurements.measure(first)
    const secondTopology = topologyMeasurements.measure(second)
    if (firstTopology === undefined || secondTopology === undefined) {
      return firstTopology === secondTopology ? compareCapacityBeamEntries(first, second) : firstTopology === undefined ? 1 : -1
    }
    const firstMetrics = firstTopology.topology
    const secondMetrics = secondTopology.topology
    const metricDifference =
      metric === 'isolated'
        ? firstMetrics.isolatedPieceCount - secondMetrics.isolatedPieceCount
        : metric === 'largest-component'
          ? secondMetrics.largestPositiveContactComponentSize -
            firstMetrics.largestPositiveContactComponentSize
          : metric === 'component-count'
            ? firstMetrics.positiveContactComponentCount -
              secondMetrics.positiveContactComponentCount
            : compareExactHullWaste(firstTopology, secondTopology)
    return metricDifference || compareCapacityBeamEntries(first, second)
  }
  const retained: CapacityBeamEntry[] = []
  const retainedKeys = new Set<string>()
  const reserve = (
    ordered: ReadonlyArray<CapacityBeamEntry>,
    maximum: number
  ): void => {
    let added = 0
    for (const entry of ordered) {
      if (retained.length >= beamWidth) return
      const key = intrinsicCapacitySuccessorIdentity(entry)
      if (retainedKeys.has(key)) continue
      retained.push(entry)
      retainedKeys.add(key)
      added += 1
      if (added >= maximum || retained.length >= beamWidth) return
    }
  }
  const bucketWidth = Math.max(1, Math.floor(beamWidth / 4))
  reserve(entries.toSorted(compareCapacityBeamEntries), bucketWidth)
  reserve(
    entries.toSorted((first, second) =>
      compareTopology(first, second, 'isolated')
    ),
    bucketWidth
  )
  reserve(
    entries.toSorted((first, second) =>
      compareTopology(first, second, 'largest-component')
    ),
    bucketWidth
  )
  reserve(
    entries.toSorted((first, second) =>
      compareTopology(first, second, 'component-count') ||
      compareTopology(first, second, 'hull-waste')
    ),
    beamWidth
  )
  reserve(entries.toSorted(compareCapacityBeamEntries), beamWidth)
  return retained
}

interface CapacityTopologyMeasurements {
  readonly measure: (
    entry: CapacityBeamEntry
  ) => CanonicalLayoutTopologyExact | undefined
  readonly counters: {
    count: number
    elapsedMs: number
  }
}

function makeCapacityTopologyMeasurements(): CapacityTopologyMeasurements {
  const topologyByIdentity = new Map<
    string,
    CanonicalLayoutTopologyExact | undefined
  >()
  const counters = { count: 0, elapsedMs: 0 }
  return {
    counters,
    measure: (entry) => {
      const identity = intrinsicCapacitySuccessorIdentity(entry)
      const cached = topologyByIdentity.get(identity)
      if (cached !== undefined || topologyByIdentity.has(identity)) return cached
      const startedAt = performance.now()
      const measured =
        entry.state.placedCollisionGeometries.length === 0
          ? undefined
          : measureCanonicalLayoutTopologyExact(
              entry.state.placedCollisionGeometries
            )
      counters.count += 1
      counters.elapsedMs += Math.max(0, performance.now() - startedAt)
      topologyByIdentity.set(identity, measured)
      return measured
    }
  }
}

function makeCapacityTopologyRetentionDepthTrace(input: {
  readonly depth: number
  readonly pieceId: PieceId
  readonly measuredSurvivors: ReadonlyArray<CapacityBeamEntry>
  readonly retained: ReadonlyArray<CapacityBeamEntry>
  readonly topologyMeasurements: CapacityTopologyMeasurements
  readonly contactFanoutTrace: {
    readonly legalCandidateCount: number
    readonly measuredCandidateCount: number
    readonly positiveCandidateCount: number
    readonly measurementMs: number
    readonly selectedSuccessorCount: number
    readonly deduplicatedSuccessorCount: number
    readonly retainedSuccessorCount: number
  }
}): IntrinsicCapacityTopologyRetentionDepthTrace {
  const retainedIdentities = new Set(
    input.retained.map(intrinsicCapacitySuccessorIdentity)
  )
  const objectiveOrdered = input.measuredSurvivors.toSorted(
    compareCapacityBeamEntries
  )
  const best = objectiveOrdered[0]
  const bestAccounting =
    best === undefined
      ? []
      : input.measuredSurvivors.filter(
          (entry) => compareCapacityBeamEntryAccounting(entry, best) === 0
        )
  const specifications: ReadonlyArray<{
    readonly role: IntrinsicCapacityTopologyRepresentativeRole
    readonly compare: (
      first: CapacityBeamEntry,
      second: CapacityBeamEntry
    ) => number
  }> = [
    { role: 'terminal-objective', compare: compareCapacityBeamEntries },
    {
      role: 'minimum-components',
      compare: (first, second) =>
        compareTopologyMetric(
          input.topologyMeasurements,
          first,
          second,
          'component-count'
        )
    },
    {
      role: 'minimum-isolated',
      compare: (first, second) =>
        compareTopologyMetric(
          input.topologyMeasurements,
          first,
          second,
          'isolated'
        )
    },
    {
      role: 'maximum-largest-component',
      compare: (first, second) =>
        compareTopologyMetric(
          input.topologyMeasurements,
          first,
          second,
          'largest-component'
        )
    },
    {
      role: 'minimum-hull-waste',
      compare: (first, second) =>
        compareTopologyMetric(
          input.topologyMeasurements,
          first,
          second,
          'hull-waste'
        )
    }
  ]
  const representatives: IntrinsicCapacityTopologyRepresentative[] = []
  for (const specification of specifications) {
    const entry = bestAccounting.toSorted(specification.compare)[0]
    if (entry === undefined) continue
    const decisionIdentity = intrinsicCapacitySuccessorIdentity(entry)
    const transition = entry.observerTransition
    if (transition === undefined) continue
    representatives.push({
      role: specification.role,
      decisionIdentity,
      parentDecisionIdentity: transition.parentDecisionIdentity,
      decision: transition.decision,
      proposalRole: transition.proposalRole,
      pieceId: transition.pieceId,
      anchoredOccupiedKey: entry.anchoredOccupiedKey,
      placedCount: entry.state.placementOrder.length,
      placedDoubledMaterialAreaGrid2:
        entry.placedDoubledMaterialAreaGrid2,
      cavities: entry.cavities,
      gridSpan: entry.gridSpan,
      topology: input.topologyMeasurements.measure(entry),
      retained: retainedIdentities.has(decisionIdentity)
    })
  }
  return {
    depth: input.depth,
    pieceId: input.pieceId,
    measuredSurvivorCount: input.measuredSurvivors.length,
    retainedCount: input.retained.length,
    bestAccountingStratumCount: bestAccounting.length,
    topologyMeasurementCount: input.topologyMeasurements.counters.count,
    topologyMeasurementMs: input.topologyMeasurements.counters.elapsedMs,
    legalCandidateCount: input.contactFanoutTrace.legalCandidateCount,
    contactMeasuredCandidateCount:
      input.contactFanoutTrace.measuredCandidateCount,
    positiveContactCandidateCount:
      input.contactFanoutTrace.positiveCandidateCount,
    contactMeasurementMs: input.contactFanoutTrace.measurementMs,
    contactSelectedSuccessorCount:
      input.contactFanoutTrace.selectedSuccessorCount,
    contactDeduplicatedSuccessorCount:
      input.contactFanoutTrace.deduplicatedSuccessorCount,
    contactRetainedSuccessorCount:
      input.contactFanoutTrace.retainedSuccessorCount,
    representatives
  }
}

function compareTopologyMetric(
  topologyMeasurements: CapacityTopologyMeasurements,
  first: CapacityBeamEntry,
  second: CapacityBeamEntry,
  metric:
    | 'isolated'
    | 'largest-component'
    | 'component-count'
    | 'hull-waste'
): number {
  const firstTopology = topologyMeasurements.measure(first)
  const secondTopology = topologyMeasurements.measure(second)
  if (firstTopology === undefined || secondTopology === undefined) {
    return firstTopology === secondTopology
      ? compareCapacityBeamEntries(first, second)
      : firstTopology === undefined
        ? 1
        : -1
  }
  const firstMetrics = firstTopology.topology
  const secondMetrics = secondTopology.topology
  const difference =
    metric === 'isolated'
      ? firstMetrics.isolatedPieceCount - secondMetrics.isolatedPieceCount
      : metric === 'largest-component'
        ? secondMetrics.largestPositiveContactComponentSize -
          firstMetrics.largestPositiveContactComponentSize
        : metric === 'component-count'
          ? firstMetrics.positiveContactComponentCount -
            secondMetrics.positiveContactComponentCount
          : compareExactHullWaste(firstTopology, secondTopology)
  return difference || compareCapacityBeamEntries(first, second)
}

function compareExactHullWaste(
  first: CanonicalLayoutTopologyExact,
  second: CanonicalLayoutTopologyExact
): number {
  if (
    first.hullDoubledAreaGrid2 === 0 ||
    second.hullDoubledAreaGrid2 === 0
  ) {
    return first.hullGapDoubledAreaGrid2 - second.hullGapDoubledAreaGrid2
  }
  const firstScaled =
    BigInt(first.hullGapDoubledAreaGrid2) *
    BigInt(second.hullDoubledAreaGrid2)
  const secondScaled =
    BigInt(second.hullGapDoubledAreaGrid2) *
    BigInt(first.hullDoubledAreaGrid2)
  return firstScaled === secondScaled ? 0 : firstScaled < secondScaled ? -1 : 1
}

function compareCapacityBeamEntriesWidthFirst(
  first: CapacityBeamEntry,
  second: CapacityBeamEntry
): number {
  return (
    compareCapacityBeamEntryAccounting(first, second) ||
    first.gridSpan.widthGrid - second.gridSpan.widthGrid ||
    first.gridSpan.heightGrid - second.gridSpan.heightGrid ||
    compareCapacityBeamEntries(first, second)
  )
}

function compareCapacityBeamEntriesHeightFirst(
  first: CapacityBeamEntry,
  second: CapacityBeamEntry
): number {
  return (
    compareCapacityBeamEntryAccounting(first, second) ||
    first.gridSpan.heightGrid - second.gridSpan.heightGrid ||
    first.gridSpan.widthGrid - second.gridSpan.widthGrid ||
    compareCapacityBeamEntries(first, second)
  )
}

function compareCapacityBeamEntryAccounting(
  first: CapacityBeamEntry,
  second: CapacityBeamEntry
): number {
  const firstCount = first.state.placementOrder.length
  const secondCount = second.state.placementOrder.length
  if (firstCount !== secondCount) return secondCount - firstCount
  if (first.placedDoubledMaterialAreaGrid2 !== second.placedDoubledMaterialAreaGrid2) {
    return first.placedDoubledMaterialAreaGrid2 > second.placedDoubledMaterialAreaGrid2 ? -1 : 1
  }
  return (
    first.cavities.count - second.cavities.count ||
    Math.round(first.cavities.totalAreaMm2 * 1_000_000) -
      Math.round(second.cavities.totalAreaMm2 * 1_000_000)
  )
}

function compareStrings(first: string, second: string): number {
  if (first < second) return -1
  if (first > second) return 1
  return 0
}

function makeCapacityPlacement(
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

function suffixMaterialSums(
  preparedIds: ReadonlyArray<PieceId>,
  materialAreasByPieceId: ReadonlyMap<PieceId, bigint>
): ReadonlyArray<bigint> | undefined {
  const sums = new Array<bigint>(preparedIds.length + 1)
  sums[preparedIds.length] = 0n
  for (let index = preparedIds.length - 1; index >= 0; index -= 1) {
    const pieceId = preparedIds[index]
    const area = pieceId === undefined ? undefined : materialAreasByPieceId.get(pieceId)
    const nextSum = sums[index + 1]
    if (area === undefined || nextSum === undefined) return undefined
    sums[index] = nextSum + area
  }
  return sums
}
