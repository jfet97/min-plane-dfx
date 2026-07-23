import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type { IrregularPreparedPiece } from '@shared/irregular/domain.js'
import type { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import type {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError,
  IrregularNfpIfpControl,
  IrregularNfpIfpControlAbortError,
  NfpIfpService
} from '../../irregular/services.js'
import { intrinsicCapacityPreparedPieceId } from './intrinsicCapacityMaterial.js'
import { IntrinsicCapacityError } from './intrinsicCapacityPreflight.js'
import {
  makeIntrinsicSharedArchiveEndpoint,
  type IntrinsicSharedArchiveEndpoint
} from './intrinsicSharedArchivePortfolio.js'
import {
  constructIntrinsicStrictState,
  type IntrinsicStrictDecoderError
} from './intrinsicStrictDecoder.js'
import { IrregularBeamState } from './irregularBeamState.js'

export const INTRINSIC_PLACE_DEFER_CHECKPOINT_VERSION =
  'intrinsic-place-defer-checkpoint-v1' as const
export const INTRINSIC_PLACE_DEFER_EVALUATION_CAP = 19_862 as const

export interface IntrinsicPlaceDeferCheckpoint {
  readonly version: typeof INTRINSIC_PLACE_DEFER_CHECKPOINT_VERSION
  readonly requestFingerprint: string
  readonly producerRole: 'experimental-place-defer-complete'
  readonly archiveCohort: 'experimental-complete'
  readonly eligibility: 'completeEligible'
  readonly state: IrregularBeamState
  readonly placedPreparedIds: ReadonlyArray<PieceId>
  readonly pendingPreparedIds: ReadonlyArray<PieceId>
  readonly deferredPreparedIds: ReadonlyArray<PieceId>
  readonly permanentlySkippedPreparedIds: ReadonlyArray<PieceId>
  readonly pendingOrder: ReadonlyArray<PieceId>
  readonly cursor: number
  readonly pass: number
  readonly deferralCounts: Readonly<Record<string, number>>
  readonly depthBoundaryResumePosition: number
  readonly placedDoubledMaterialAreaGrid2: bigint
  readonly enclosedCavityCount: number
  readonly totalEnclosedCavityAreaMm2: number
  readonly anchoredOccupiedIdentity: string
  readonly fitMask: {
    readonly q0: boolean
    readonly q90: boolean
  }
  readonly budgetLedgers: {
    readonly totalPlacementEvaluationCap: number
    readonly totalConsumedPlacementEvaluations: number
    readonly perDepth: ReadonlyArray<{
      readonly depth: number
      readonly consumedPlacementEvaluations: number
    }>
    readonly perCohort: {
      readonly complete: number
      readonly partial: number
      readonly experimentalComplete: number
    }
  }
  readonly schedulerDeficit: number
  readonly settlement: 'active'
  readonly censoring: 'none'
  readonly noSkipFrontier: {
    readonly present: true
    readonly firstLossDepth: undefined
  }
}

export interface IntrinsicPlaceDeferTrace {
  readonly version: typeof INTRINSIC_PLACE_DEFER_CHECKPOINT_VERSION
  readonly deferredPreparedId: PieceId | undefined
  readonly pendingOrder: ReadonlyArray<PieceId>
  readonly status: 'paused' | 'completed' | 'incomplete' | 'evaluation-cap'
  readonly candidateEvaluations: number
  readonly placedCount: number
  readonly unplacedCount: number
  readonly completeEndpointHash: string | undefined
  readonly requestedSheetFit: {
    readonly q0: boolean
    readonly q90: boolean
  }
  readonly outputInfluence: 'none'
}

export interface IntrinsicPlaceDeferResult {
  readonly status: 'paused' | 'settled'
  readonly checkpoint: IntrinsicPlaceDeferCheckpoint | undefined
  readonly endpoint: IntrinsicSharedArchiveEndpoint | undefined
  readonly trace: IntrinsicPlaceDeferTrace
}

export interface RunIntrinsicPlaceDeferInput {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly control?: IrregularNfpIfpControl
  readonly checkpoint?: IntrinsicPlaceDeferCheckpoint
  readonly maximumDecisionBoundaries?: 1
}

type IntrinsicPlaceDeferError =
  | IntrinsicCapacityError
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError

/**
 * Runs one protected shadow lane that defers the first pending piece to a
 * second pass. Only a skip-free complete endpoint is exposed; the producer has
 * no output or legacy-archive authority.
 */
export function runIntrinsicPlaceDeferCompleteShadow(
  input: RunIntrinsicPlaceDeferInput
): Effect.Effect<
  IntrinsicPlaceDeferResult,
  IntrinsicPlaceDeferError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const requestFingerprint = intrinsicPlaceDeferFingerprint(input)
    const freshCheckpoint = makePlaceDeferCheckpoint(input, requestFingerprint)
    const checkpoint = input.checkpoint ?? freshCheckpoint
    const checkpointError = validatePlaceDeferCheckpoint(input, checkpoint, requestFingerprint)
    if (checkpointError !== undefined) {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'placeDeferCheckpoint',
          message: checkpointError
        })
      )
    }
    const deferredPreparedId = checkpoint.deferredPreparedIds[0]
    if (input.checkpoint === undefined && input.maximumDecisionBoundaries === 1) {
      return {
        status: 'paused',
        checkpoint,
        endpoint: undefined,
        trace: {
          version: INTRINSIC_PLACE_DEFER_CHECKPOINT_VERSION,
          deferredPreparedId,
          pendingOrder: checkpoint.pendingOrder,
          status: 'paused',
          candidateEvaluations: 0,
          placedCount: 0,
          unplacedCount: 0,
          completeEndpointHash: undefined,
          requestedSheetFit: checkpoint.fitMask,
          outputInfluence: 'none'
        }
      }
    }

    const piecesById = new Map(
      input.preparedPieces.map((piece) => [intrinsicCapacityPreparedPieceId(piece), piece] as const)
    )
    const reordered = checkpoint.pendingOrder.flatMap((pieceId) => {
      const piece = piecesById.get(pieceId)
      return piece === undefined ? [] : [piece]
    })
    const constructed = yield* constructIntrinsicStrictState({
      allPreparedPieces: input.preparedPieces,
      remainingPreparedPieces: reordered,
      frozenPlaced: [],
      candidateMode: 'pure-growth',
      maximumCandidateEvaluationCount: INTRINSIC_PLACE_DEFER_EVALUATION_CAP,
      captureCandidateEvaluationCount: true,
      ...(input.control === undefined ? {} : { control: input.control })
    })
    const complete =
      constructed.truncationReason === undefined &&
      constructed.state.remainingPreparedPieces.length === 0 &&
      constructed.state.unplacedPieceIds.length === 0
    const endpoint = complete
      ? makeIntrinsicSharedArchiveEndpoint({
          sheet: input.sheet,
          role: 'experimental-place-defer-complete',
          sourceId:
            deferredPreparedId === undefined ? undefined : `deferred:${deferredPreparedId}`,
          state: constructed.state,
          runtimeMs: 0
        })
      : undefined
    const status =
      constructed.truncationReason === 'maximum-candidate-evaluations'
        ? 'evaluation-cap'
        : endpoint === undefined
          ? 'incomplete'
          : 'completed'
    return {
      status: 'settled',
      checkpoint: undefined,
      endpoint,
      trace: {
        version: INTRINSIC_PLACE_DEFER_CHECKPOINT_VERSION,
        deferredPreparedId,
        pendingOrder: checkpoint.pendingOrder,
        status,
        candidateEvaluations: constructed.candidateEvaluationCount ?? 0,
        placedCount: constructed.state.placementOrder.length,
        unplacedCount: constructed.state.unplacedPieceIds.length,
        completeEndpointHash: endpoint?.sheetlessCanonicalGeometryHash,
        requestedSheetFit: {
          q0: endpoint?.requestedSheetFit.q0.fits ?? false,
          q90: endpoint?.requestedSheetFit.q90.fits ?? false
        },
        outputInfluence: 'none'
      }
    }
  })
}

function makePlaceDeferCheckpoint(
  input: RunIntrinsicPlaceDeferInput,
  requestFingerprint: string
): IntrinsicPlaceDeferCheckpoint {
  const preparedIds = input.preparedPieces.map(intrinsicCapacityPreparedPieceId)
  const deferredPreparedId = preparedIds[0]
  const pendingPreparedIds = preparedIds.slice(1)
  const deferredPreparedIds =
    deferredPreparedId === undefined ? [] : [deferredPreparedId]
  const pendingOrder = [...pendingPreparedIds, ...deferredPreparedIds]
  const state = IrregularBeamState.empty(
    pendingOrder.flatMap((pieceId) => {
      const piece = input.preparedPieces.find(
        (candidate) => intrinsicCapacityPreparedPieceId(candidate) === pieceId
      )
      return piece === undefined ? [] : [piece]
    })
  )
  return {
    version: INTRINSIC_PLACE_DEFER_CHECKPOINT_VERSION,
    requestFingerprint,
    producerRole: 'experimental-place-defer-complete',
    archiveCohort: 'experimental-complete',
    eligibility: 'completeEligible',
    state,
    placedPreparedIds: [],
    pendingPreparedIds,
    deferredPreparedIds,
    permanentlySkippedPreparedIds: [],
    pendingOrder,
    cursor: 0,
    pass: 0,
    deferralCounts:
      deferredPreparedId === undefined ? {} : { [deferredPreparedId]: 1 },
    depthBoundaryResumePosition: 0,
    placedDoubledMaterialAreaGrid2: 0n,
    enclosedCavityCount: 0,
    totalEnclosedCavityAreaMm2: 0,
    anchoredOccupiedIdentity: state.canonicalOccupiedGeometryKey,
    fitMask: { q0: true, q90: true },
    budgetLedgers: {
      totalPlacementEvaluationCap: INTRINSIC_PLACE_DEFER_EVALUATION_CAP,
      totalConsumedPlacementEvaluations: 0,
      perDepth: [],
      perCohort: { complete: 0, partial: 0, experimentalComplete: 0 }
    },
    schedulerDeficit: 1,
    settlement: 'active',
    censoring: 'none',
    noSkipFrontier: { present: true, firstLossDepth: undefined }
  }
}

function validatePlaceDeferCheckpoint(
  input: RunIntrinsicPlaceDeferInput,
  checkpoint: IntrinsicPlaceDeferCheckpoint,
  requestFingerprint: string
): string | undefined {
  const preparedIds = input.preparedPieces.map(intrinsicCapacityPreparedPieceId)
  const expectedDeferredId = preparedIds[0]
  const expectedPendingIds = preparedIds.slice(1)
  const expectedDeferredIds =
    expectedDeferredId === undefined ? [] : [expectedDeferredId]
  const expectedPendingOrder = [...expectedPendingIds, ...expectedDeferredIds]
  const stateRemainingIds = checkpoint.state.remainingPreparedPieces.map(
    intrinsicCapacityPreparedPieceId
  )
  const partition = [
    ...checkpoint.placedPreparedIds,
    ...checkpoint.pendingPreparedIds,
    ...checkpoint.deferredPreparedIds,
    ...checkpoint.permanentlySkippedPreparedIds
  ]
  if (
    checkpoint.version !== INTRINSIC_PLACE_DEFER_CHECKPOINT_VERSION ||
    checkpoint.requestFingerprint !== requestFingerprint
  ) {
    return 'checkpoint version or request fingerprint differs.'
  }
  if (
    checkpoint.producerRole !== 'experimental-place-defer-complete' ||
    checkpoint.archiveCohort !== 'experimental-complete' ||
    checkpoint.eligibility !== 'completeEligible'
  ) {
    return 'checkpoint producer, archive cohort, or eligibility differs.'
  }
  if (
    partition.length !== preparedIds.length ||
    new Set(partition).size !== partition.length ||
    partition.toSorted().some((pieceId, index) => pieceId !== preparedIds.toSorted()[index])
  ) {
    return 'checkpoint placed, pending, deferred, and skipped ids must partition the request.'
  }
  if (
    checkpoint.permanentlySkippedPreparedIds.length > 0 ||
    checkpoint.pendingPreparedIds.some(
      (pieceId, index) => pieceId !== expectedPendingIds[index]
    ) ||
    checkpoint.pendingPreparedIds.length !== expectedPendingIds.length ||
    checkpoint.deferredPreparedIds.some(
      (pieceId, index) => pieceId !== expectedDeferredIds[index]
    ) ||
    checkpoint.deferredPreparedIds.length !== expectedDeferredIds.length ||
    checkpoint.pendingOrder.some(
      (pieceId, index) => pieceId !== expectedPendingOrder[index]
    ) ||
    checkpoint.pendingOrder.length !== expectedPendingOrder.length ||
    stateRemainingIds.some((pieceId, index) => pieceId !== expectedPendingOrder[index]) ||
    stateRemainingIds.length !== expectedPendingOrder.length
  ) {
    return 'complete-eligible defer and pending orders differ from the deterministic transition.'
  }
  if (
    checkpoint.placedPreparedIds.length !== 0 ||
    checkpoint.placedDoubledMaterialAreaGrid2 !== 0n ||
    checkpoint.enclosedCavityCount !== 0 ||
    checkpoint.totalEnclosedCavityAreaMm2 !== 0 ||
    checkpoint.anchoredOccupiedIdentity !== checkpoint.state.canonicalOccupiedGeometryKey ||
    checkpoint.state.placedCollisionGeometries.length !== 0 ||
    checkpoint.state.unplacedPieceIds.length !== 0 ||
    !checkpoint.fitMask.q0 ||
    !checkpoint.fitMask.q90
  ) {
    return 'initial defer checkpoint exact geometry accounting differs.'
  }
  const deferralEntries = Object.entries(checkpoint.deferralCounts)
  if (
    (expectedDeferredId === undefined &&
      deferralEntries.length !== 0) ||
    (expectedDeferredId !== undefined &&
      (deferralEntries.length !== 1 ||
        deferralEntries[0]?.[0] !== expectedDeferredId ||
        deferralEntries[0]?.[1] !== 1))
  ) {
    return 'checkpoint deferral counters differ from the deterministic transition.'
  }
  if (
    checkpoint.cursor !== 0 ||
    checkpoint.pass !== 0 ||
    checkpoint.depthBoundaryResumePosition !== 0 ||
    checkpoint.budgetLedgers.totalPlacementEvaluationCap !==
      INTRINSIC_PLACE_DEFER_EVALUATION_CAP ||
    checkpoint.budgetLedgers.totalConsumedPlacementEvaluations !== 0 ||
    checkpoint.budgetLedgers.perDepth.length !== 0 ||
    checkpoint.budgetLedgers.perCohort.complete !== 0 ||
    checkpoint.budgetLedgers.perCohort.partial !== 0 ||
    checkpoint.budgetLedgers.perCohort.experimentalComplete !== 0 ||
    checkpoint.schedulerDeficit !== 1 ||
    checkpoint.settlement !== 'active' ||
    checkpoint.censoring !== 'none' ||
    !checkpoint.noSkipFrontier.present ||
    checkpoint.noSkipFrontier.firstLossDepth !== undefined
  ) {
    return 'checkpoint resume position, ledgers, or settlement state differs.'
  }
  return undefined
}

function intrinsicPlaceDeferFingerprint(input: RunIntrinsicPlaceDeferInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        {
          version: INTRINSIC_PLACE_DEFER_CHECKPOINT_VERSION,
          sheet: { width: input.sheet.width, height: input.sheet.height },
          preparedPieces: input.preparedPieces
        },
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)
      )
    )
    .digest('hex')
}
