import { Data, Effect, Layer } from 'effect'
import { performance } from 'node:perf_hooks'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { PieceId } from '@shared/domain/ids.js'
import type { NestingRequest } from '@shared/domain/nesting.js'
import {
  CollisionGeometryDiagnostic,
  IrregularPlacedPiece,
  IrregularPortfolioResult,
  IrregularPortfolioProgress,
  IrregularPriorityOrderKey,
  IrregularPreparedPiece,
  IrregularTransformCandidate
} from '@shared/irregular/domain.js'
import { CollisionGeometryBuilder } from '../../irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError,
  IrregularNestingPortfolio,
  IrregularPortfolioError,
  NfpIfpService,
  TransformGenerator
} from '../../irregular/services.js'
import { sortPiecesForNesting } from '../sortPiecesForNesting.js'
import {
  IrregularLayoutScore,
  IrregularLayoutScoringError,
  IrregularLayoutScorer
} from './irregularLayoutScorer.js'
import {
  IrregularPlacementScorer,
  IrregularPlacementScoringError
} from './irregularPlacementScorer.js'
import { IrregularBeamState } from './irregularBeamState.js'
import {
  IrregularNestingPortfolioLive,
  type IrregularPortfolioMetrics,
  type IrregularPortfolioPhaseMeasurement
} from './portfolioSearch.js'
import { PriorityOrderServiceLive } from './priorityOrderService.js'
import type { EmitIrregularDecisionTrace } from './decisionTrace.js'

/** Reports that a prepared piece has no imported geometry available to the worker. */
export class IrregularComputeError extends Data.TaggedError('IrregularComputeError')<{
  readonly preparedPieceId: PieceId
  readonly sourcePieceId: PieceId
  readonly message: string
}> {}

/** One real beam state emitted by the irregular decoder. */
export interface IrregularStateSnapshot {
  readonly stepIndex: number
  readonly beamRank: number
  readonly candidateCount: number
  readonly state: IrregularBeamState
}

/** Benchmark-only measurements for materializing the selected portfolio result. */
export interface IrregularFinalizationMetrics {
  readonly reconstructionElapsedMs: number
  readonly finalScoreElapsedMs: number
}

/** Synchronous worker-facing notification for one selected real beam state. */
export interface ComputeIrregularNestingOptions {
  readonly emitStateSnapshot?: (snapshot: IrregularStateSnapshot, beamWidth: number) => void
  readonly emitDecisionTrace?: EmitIrregularDecisionTrace
  readonly emitPortfolioProgress?: (progress: IrregularPortfolioProgress) => Effect.Effect<void>
  readonly isCancelled?: () => boolean
  /** standalone benchmark hook; measurements never enter normal app output. */
  readonly onPortfolioPhase?: (measurement: IrregularPortfolioPhaseMeasurement) => void
  /** standalone benchmark hook; metrics never enter normal app output. */
  readonly onPortfolioMetrics?: (metrics: IrregularPortfolioMetrics) => void
  /** standalone benchmark hook; metrics never enter normal app output. */
  readonly onFinalizationMetrics?: (metrics: IrregularFinalizationMetrics) => void
}

/** Plain algorithm output before any worker protocol or history DTO adaptation. */
export interface IrregularComputeResult {
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly score: IrregularLayoutScore
  readonly unplacedPieceIds: ReadonlyArray<PieceId>
  readonly diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>
  readonly sortedPieceIds: ReadonlyArray<PieceId>
  readonly stateSnapshots: ReadonlyArray<IrregularStateSnapshot>
  readonly beamWidth: number
  readonly portfolio: IrregularPortfolioResult
}

export type IrregularComputeErrorType =
  | IrregularComputeError
  | IrregularGeometryInputError
  | IrregularNestingNotImplementedError
  | IrregularPortfolioError
  | IrregularPlacementScoringError
  | IrregularLayoutScoringError

export function computeIrregularNesting(
  request: NestingRequest,
  options?: ComputeIrregularNestingOptions
): Effect.Effect<
  IrregularComputeResult,
  IrregularComputeErrorType,
  | GeometrySettings
  | GeometryKernel
  | CollisionGeometryBuilder
  | TransformGenerator
  | NfpIfpService
  | IrregularPlacementScorer
  | IrregularLayoutScorer
> {
  return Effect.gen(function* () {
    const settings = yield* GeometrySettings
    const sortedPieces = sortPiecesForNesting(request.pieces)
    const sourcePieces = request.sourcePieces ?? []
    const preparedPieces: IrregularPreparedPiece[] = []
    const diagnostics: CollisionGeometryDiagnostic[] = []
    const geometryBuilder = yield* CollisionGeometryBuilder
    const geometryKernel = yield* GeometryKernel
    const transformGenerator = yield* TransformGenerator
    const layoutScorer = yield* IrregularLayoutScorer

    for (const prepared of sortedPieces) {
      const source = findSourcePiece(prepared.sourcePieceId, prepared.id, sourcePieces)
      if (source === undefined) {
        return yield* Effect.fail(
          new IrregularComputeError({
            preparedPieceId: prepared.id,
            sourcePieceId: prepared.sourcePieceId,
            message: `No imported source geometry was found for prepared piece ${prepared.id}.`
          })
        )
      }

      const collisionGeometry = yield* geometryBuilder.buildPiece({
        piece: source,
        totalPaddingMm: request.padding
      })
      const allowRotation = request.options.allowGlobalRotation && prepared.allowRotation
      const allowMirror = (request.options.allowGlobalMirror ?? true) && (prepared.allowMirror ?? true)
      const transforms = yield* transformGenerator.generateTransforms({
        geometry: collisionGeometry,
        allowRotation,
        allowMirror,
        settings: settings.optimizer
      })
      preparedPieces.push(
        new IrregularPreparedPiece({
          pieceId: prepared.id,
          interchangeabilityKey: prepared.interchangeabilityKey ?? prepared.id,
          source,
          allowMirror,
          collisionGeometry,
          transforms,
          priorityOrderKey: new IrregularPriorityOrderKey({
            longSideMm: prepared.paddedBounds.longestEdge,
            areaMm2: prepared.paddedBounds.area,
            imbalanceMm: prepared.paddedBounds.imbalance
          })
        })
      )
      diagnostics.push(...collisionGeometry.diagnostics)
    }

    const stateSnapshots: IrregularStateSnapshot[] = []
    const captureStateSnapshot = (snapshot: IrregularStateSnapshot): void => {
      const capturedSnapshot: IrregularStateSnapshot = {
        ...snapshot,
        stepIndex: preparedPieces.length - snapshot.state.remainingPreparedPieces.length
      }
      stateSnapshots.push(capturedSnapshot)
      options?.emitStateSnapshot?.(capturedSnapshot, settings.optimizer.beamWidth)
    }
    const portfolioService = yield* Effect.service(IrregularNestingPortfolio).pipe(
      Effect.provide(
        IrregularNestingPortfolioLive.pipe(Layer.provideMerge(PriorityOrderServiceLive))
      )
    )
    const instrumentation =
      options?.onPortfolioPhase === undefined && options?.onPortfolioMetrics === undefined
        ? undefined
        : {
            ...(options?.onPortfolioPhase !== undefined
              ? { onPhase: options.onPortfolioPhase }
              : {}),
            ...(options?.onPortfolioMetrics !== undefined
              ? { onMetrics: options.onPortfolioMetrics }
              : {})
          }
    const portfolioInput = {
      sheet: request.sheet,
      pieces: preparedPieces,
      ...(request.options.historyMode !== 'off'
        ? {
            onStateSnapshot: (snapshot: IrregularStateSnapshot) => {
              captureStateSnapshot(snapshot)
            }
          }
        : {}),
      ...(request.options.historyMode !== 'off' && options?.emitDecisionTrace !== undefined
        ? { emitDecisionTrace: options.emitDecisionTrace }
        : {}),
      ...(options?.emitPortfolioProgress !== undefined
        ? { onProgress: options.emitPortfolioProgress }
        : {}),
      ...(options?.isCancelled !== undefined ? { isCancelled: options.isCancelled } : {}),
      ...(instrumentation !== undefined ? { instrumentation } : {})
    }
    const portfolio = yield* portfolioService.run(portfolioInput)
    const reconstructionStartedAt =
      options?.onFinalizationMetrics === undefined ? 0 : performance.now()
    const placedCollisionGeometries = yield* reconstructPlacedGeometry(
      portfolio,
      preparedPieces,
      geometryKernel
    )
    const reconstructionElapsedMs =
      options?.onFinalizationMetrics === undefined
        ? 0
        : Math.max(0, performance.now() - reconstructionStartedAt)
    const reconstructedState = new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries,
      unplacedPieceIds: portfolio.unplacedPieceIds,
      placementOrder: placedCollisionGeometries.map(
        ({ placement }) => placement.pieceId ?? placement.sourcePieceId
      )
    })
    const finalScoreStartedAt =
      options?.onFinalizationMetrics === undefined ? 0 : performance.now()
    const score = yield* layoutScorer.scoreState({
      sheet: request.sheet,
      state: reconstructedState
    })
    if (options?.onFinalizationMetrics !== undefined) {
      options.onFinalizationMetrics({
        reconstructionElapsedMs,
        finalScoreElapsedMs: Math.max(0, performance.now() - finalScoreStartedAt)
      })
    }
    diagnostics.push(...score.freeMaterialSnapshot.diagnostics)
    return {
      placedCollisionGeometries,
      score,
      unplacedPieceIds: portfolio.unplacedPieceIds,
      diagnostics,
      sortedPieceIds: sortedPieces.map((piece) => piece.id),
      stateSnapshots,
      beamWidth: settings.optimizer.beamWidth,
      portfolio
    }
  })
}

function reconstructPlacedGeometry(
  portfolio: IrregularPortfolioResult,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  geometryKernel: import('../../irregular/geometryKernel.js').GeometryKernel.Service
): Effect.Effect<
  ReadonlyArray<IrregularPlacedPiece>,
  IrregularComputeError | IrregularGeometryInputError | IrregularNestingNotImplementedError
> {
  return Effect.forEach(
    portfolio.placements,
    (
      placement
    ): Effect.Effect<
      IrregularPlacedPiece,
      IrregularComputeError | IrregularGeometryInputError | IrregularNestingNotImplementedError
    > => {
      const prepared = pieces.find(
        (piece) =>
          (piece.pieceId ?? piece.source.id) === (placement.pieceId ?? placement.sourcePieceId) &&
          piece.source.id === placement.sourcePieceId
      )
      if (prepared === undefined) {
        return Effect.fail(
          new IrregularComputeError({
            preparedPieceId: placement.pieceId ?? placement.sourcePieceId,
            sourcePieceId: placement.sourcePieceId,
            message: `Portfolio placement ${placement.sourcePieceId} has no prepared piece.`
          })
        )
      }
      const transform = resolvePortfolioPlacementTransform({
        transforms: prepared.transforms,
        rotationDeg: placement.transform.rotationDeg,
        mirrored: placement.transform.mirrored
      })
      if (transform === undefined) {
        return Effect.fail(
          new IrregularGeometryInputError({
            operation: 'reconstructPortfolioPlacement',
            message: `Portfolio placement ${placement.sourcePieceId} has no matching transform candidate.`
          })
        )
      }
      return geometryKernel
        .transformCollisionGeometry({
          geometry: prepared.collisionGeometry,
          transform
        })
        .pipe(
          Effect.map(
            (collisionGeometry) => new IrregularPlacedPiece({ placement, collisionGeometry })
          )
        )
    },
    { concurrency: 1 }
  )
}

/**
 * Resolves a selected placement to geometry that can be reconstructed from the
 * prepared finite transform set.
 *
 * Terminal orientation may rigidly quarter-turn a completed legal layout after
 * search. Such an absolute angle does not need to consume one of the capped
 * per-piece search transforms, but it must remain a quarter-turn of one that
 * was actually prepared.
 */
export function resolvePortfolioPlacementTransform(input: {
  readonly transforms: ReadonlyArray<IrregularTransformCandidate>
  readonly rotationDeg: number
  readonly mirrored: boolean
}): IrregularTransformCandidate | undefined {
  const sameMirrorTransforms = input.transforms
    .filter((candidate) => candidate.mirrored === input.mirrored)
    .toSorted((first, second) => first.index - second.index)
  const exact = sameMirrorTransforms.find(
    (candidate) => candidate.rotationDeg === input.rotationDeg
  )
  if (exact !== undefined) return exact

  const quarterTurnBase = sameMirrorTransforms.find((candidate) =>
    isQuarterTurnEquivalent(candidate.rotationDeg, input.rotationDeg)
  )
  if (quarterTurnBase === undefined) return undefined

  return new IrregularTransformCandidate({
    index: quarterTurnBase.index,
    rotationDeg: input.rotationDeg,
    mirrored: input.mirrored,
    reason: quarterTurnBase.reason
  })
}

function isQuarterTurnEquivalent(firstRotationDeg: number, secondRotationDeg: number): boolean {
  const normalizedDifference = normalizeRotationDegrees(secondRotationDeg - firstRotationDeg)
  return [0, 90, 180, 270].some(
    (quarterTurnDeg) => Math.abs(normalizedDifference - quarterTurnDeg) <= 1e-9
  )
}

function normalizeRotationDegrees(rotationDeg: number): number {
  const remainder = rotationDeg % 360
  return remainder < 0 ? remainder + 360 : remainder
}

function findSourcePiece(
  sourcePieceId: PieceId,
  preparedPieceId: PieceId,
  sourcePieces: ReadonlyArray<ImportedPiece>
): ImportedPiece | undefined {
  const direct = sourcePieces.find(
    (source) => source.id === sourcePieceId || source.id === preparedPieceId
  )
  if (direct !== undefined) return direct

  const baseId = sourcePieceId.replace(/-copy-\d+$/, '')
  const preparedBaseId = preparedPieceId.replace(/-copy-\d+$/, '')
  const base = sourcePieces.find((source) => source.id === baseId || source.id === preparedBaseId)
  return base
}
