import { Data, Effect, Layer } from 'effect'
import { performance } from 'node:perf_hooks'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { PieceId } from '@shared/domain/ids.js'
import { SheetSpec, type NestingRequest } from '@shared/domain/nesting.js'
import {
  CollisionGeometryDiagnostic,
  IrregularPlacedPiece,
  IrregularLayoutScoreSummary,
  IrregularPortfolioResult,
  IrregularPortfolioProgress,
  IrregularPriorityOrderKey,
  IrregularPreparedPiece,
  IrregularTransformCandidate,
  type IrregularNestingSettings
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
import {
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalLayoutTopology,
  type CanonicalLayoutTopology
} from '../../irregular/canonicalLayoutGeometry.js'

export const CANONICAL_REFERENCE_SHEET = new SheetSpec({
  width: 2000,
  height: 2700,
  label: 'canonical-reference-2000x2700'
})

/** Exact protected-role admission slacks; these are not comparator weights. */
export const CANONICAL_REFERENCE_ADMISSION_SLACKS = {
  maximumMaxSideRegressionRatio: 0.075,
  maximumTotalContactLoss: 4,
  maximumDominantContactLoss: 3
} as const

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

    const portfolioService = yield* Effect.service(IrregularNestingPortfolio).pipe(
      Effect.provide(
        IrregularNestingPortfolioLive.pipe(Layer.provideMerge(PriorityOrderServiceLive))
      )
    )
    return yield* coordinateCanonicalReferenceDecode({
      request,
      settings,
      preparedPieces,
      diagnostics,
      sortedPieceIds: sortedPieces.map((piece) => piece.id),
      portfolioService,
      geometryKernel,
      layoutScorer,
      options
    })
  })
}

interface SingleSheetDecode {
  readonly sheet: SheetSpec
  readonly portfolio: IrregularPortfolioResult
  readonly terminalState: IrregularBeamState | undefined
  readonly stateSnapshots: ReadonlyArray<IrregularStateSnapshot>
  readonly metrics: IrregularPortfolioMetrics | undefined
}

interface CanonicalReferenceCoordinatorInput {
  readonly request: NestingRequest
  readonly settings: IrregularNestingSettings
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>
  readonly sortedPieceIds: ReadonlyArray<PieceId>
  readonly portfolioService: IrregularNestingPortfolio
  readonly geometryKernel: GeometryKernel.Service
  readonly layoutScorer: IrregularLayoutScorer.Service
  readonly options: ComputeIrregularNestingOptions | undefined
}

/**
 * Coordinates the real-sheet portfolio and one protected canonical-reference portfolio.
 *
 * This is deliberately outside the single-sheet portfolio primitive: neither role can
 * recurse into this coordinator or into `computeIrregularNesting`.
 */
function coordinateCanonicalReferenceDecode(
  input: CanonicalReferenceCoordinatorInput
): Effect.Effect<
  IrregularComputeResult,
  IrregularComputeErrorType
> {
  return Effect.gen(function* () {
    const production = yield* runSingleSheetPortfolio(input, input.request.sheet, true)
    const shouldAttemptCanonical = isCanonicalReferenceRoleEligible(input.request, input.settings)
    const reusesProduction = isCanonicalReferenceSheet(input.request.sheet) && shouldAttemptCanonical
    const canonical =
      shouldAttemptCanonical && !reusesProduction && production.portfolio.status !== 'cancelled'
        ? yield* runSingleSheetPortfolio(input, CANONICAL_REFERENCE_SHEET, false)
        : production

    if (input.options?.onPortfolioMetrics !== undefined) {
      const metrics = combinePortfolioMetrics(
        production.metrics,
        canonical === production ? undefined : canonical.metrics
      )
      if (metrics !== undefined) input.options.onPortfolioMetrics(metrics)
    }

    const productionFinal = yield* materializeProductionResult(input, production)
    let selected = productionFinal
    const roleDiagnostics: CollisionGeometryDiagnostic[] = shouldAttemptCanonical
      ? [
          reusesProduction
            ? canonicalRoleDiagnostic('admitted', 'reference sheet reused the ordinary decode')
            : canonicalRoleDiagnostic('attempted', 'protected canonical-reference decode completed')
        ]
      : []

    if (canonical !== production && canonical.portfolio.status === 'cancelled') {
      selected = {
        ...productionFinal,
        portfolio: withCancelledPortfolioStatus(productionFinal.portfolio)
      }
      roleDiagnostics.push(
        canonicalRoleDiagnostic('rejected', 'protected canonical-reference decode was cancelled')
      )
    } else if (shouldAttemptCanonical && !reusesProduction && canonical.terminalState !== undefined) {
      const candidates = yield* fittingCanonicalCandidates(input, canonical)
      if (candidates.length > 0) {
        let rejectedReason = 'canonical role had no admissible rigid orientation'
        let admittedCandidate: FittingCanonicalCandidate | undefined
        for (const candidate of candidates) {
          const decision = evaluateCanonicalReferenceAdmission({
            productionScore: productionFinal.score,
            productionPlaced: productionFinal.placedCollisionGeometries,
            canonicalScore: candidate.score,
            canonicalPlaced: candidate.state.placedCollisionGeometries
          })
          if (decision.admitted) {
            admittedCandidate = candidate
            rejectedReason = decision.reason
            break
          }
          rejectedReason = decision.reason
        }
        if (admittedCandidate !== undefined) {
          const materialized = materializeCanonicalResult(input, canonical, admittedCandidate)
          if (materialized === undefined) {
            roleDiagnostics.push(
              canonicalRoleDiagnostic('rejected', 'canonical history could not be rigidly oriented')
            )
          } else {
            selected = materialized
            roleDiagnostics.push(canonicalRoleDiagnostic('admitted', rejectedReason))
            roleDiagnostics.push(
              canonicalRoleDiagnostic('selected', 'canonical role replaced production')
            )
          }
        } else {
          roleDiagnostics.push(canonicalRoleDiagnostic('rejected', rejectedReason))
        }
      } else {
        roleDiagnostics.push(canonicalRoleDiagnostic(
          'rejected',
          'canonical collision arrangement does not fit the requested sheet at q0 or q90'
        ))
      }
    }

    for (const snapshot of selected.stateSnapshots) {
      input.options?.emitStateSnapshot?.(snapshot, input.settings.optimizer.beamWidth)
    }
    return {
      ...selected,
      diagnostics: [
        ...input.diagnostics,
        ...selected.score.freeMaterialSnapshot.diagnostics,
        ...roleDiagnostics
      ],
      sortedPieceIds: input.sortedPieceIds,
      beamWidth: input.settings.optimizer.beamWidth
    }
  })
}

function withCancelledPortfolioStatus(portfolio: IrregularPortfolioResult): IrregularPortfolioResult {
  return new IrregularPortfolioResult({
    ...portfolio,
    status: 'cancelled',
    terminationReason: 'cancelled'
  })
}

function runSingleSheetPortfolio(
  input: CanonicalReferenceCoordinatorInput,
  sheet: SheetSpec,
  publishProgress: boolean
): Effect.Effect<SingleSheetDecode, IrregularComputeErrorType> {
  return Effect.gen(function* () {
    const stateSnapshots: IrregularStateSnapshot[] = []
    let terminalState: IrregularBeamState | undefined
    let metrics: IrregularPortfolioMetrics | undefined
    const instrumentation =
      input.options?.onPortfolioPhase === undefined &&
      input.options?.onPortfolioMetrics === undefined
        ? undefined
        : {
            ...(input.options?.onPortfolioPhase !== undefined
              ? { onPhase: input.options.onPortfolioPhase }
              : {}),
            ...(input.options?.onPortfolioMetrics !== undefined
              ? {
                  onMetrics: (nextMetrics: IrregularPortfolioMetrics) => {
                    metrics = nextMetrics
                  }
                }
              : {})
          }
    const portfolioInput = {
      sheet,
      pieces: input.preparedPieces,
      ...(input.request.options.historyMode !== 'off'
        ? {
            onStateSnapshot: (snapshot: IrregularStateSnapshot) => {
              stateSnapshots.push({
                ...snapshot,
                stepIndex:
                  input.preparedPieces.length - snapshot.state.remainingPreparedPieces.length
              })
            }
          }
        : {}),
      onSelectedState: (state: IrregularBeamState) => {
        terminalState = state
      },
      ...(publishProgress && input.options?.emitPortfolioProgress !== undefined
        ? { onProgress: input.options.emitPortfolioProgress }
        : {}),
      ...(publishProgress &&
      input.request.options.historyMode !== 'off' &&
      input.options?.emitDecisionTrace !== undefined
        ? { emitDecisionTrace: input.options.emitDecisionTrace }
        : {}),
      ...(input.options?.isCancelled !== undefined
        ? { isCancelled: input.options.isCancelled }
        : {}),
      ...(instrumentation !== undefined ? { instrumentation } : {})
    }
    const portfolio = yield* input.portfolioService.run(portfolioInput)
    return { sheet, portfolio, terminalState, stateSnapshots, metrics }
  })
}

type MaterializedDecode = IrregularComputeResult

function materializeProductionResult(
  input: CanonicalReferenceCoordinatorInput,
  decoded: SingleSheetDecode
): Effect.Effect<MaterializedDecode, IrregularComputeErrorType> {
  return Effect.gen(function* () {
    const reconstructionStartedAt =
      input.options?.onFinalizationMetrics === undefined ? 0 : performance.now()
    const placedCollisionGeometries = yield* reconstructPlacedGeometry(
      decoded.portfolio,
      input.preparedPieces,
      input.geometryKernel
    )
    const reconstructionElapsedMs =
      input.options?.onFinalizationMetrics === undefined
        ? 0
        : Math.max(0, performance.now() - reconstructionStartedAt)
    const reconstructedState = new IrregularBeamState({
      remainingPreparedPieces: [],
      placedCollisionGeometries,
      unplacedPieceIds: decoded.portfolio.unplacedPieceIds,
      placementOrder: placedCollisionGeometries.map(
        ({ placement }) => placement.pieceId ?? placement.sourcePieceId
      )
    })
    const scoringStartedAt =
      input.options?.onFinalizationMetrics === undefined ? 0 : performance.now()
    const reconstructedScore = yield* input.layoutScorer.scoreState({
      sheet: input.request.sheet,
      state: reconstructedState
    })
    const score = preservePortfolioContactMetrics(reconstructedScore, decoded.portfolio.score)
    input.options?.onFinalizationMetrics?.({
      reconstructionElapsedMs,
      finalScoreElapsedMs: Math.max(0, performance.now() - scoringStartedAt)
    })
    return {
      placedCollisionGeometries,
      score,
      unplacedPieceIds: decoded.portfolio.unplacedPieceIds,
      diagnostics: [],
      sortedPieceIds: input.sortedPieceIds,
      stateSnapshots: decoded.stateSnapshots,
      beamWidth: input.settings.optimizer.beamWidth,
      portfolio: decoded.portfolio
    }
  })
}

interface FittingCanonicalCandidate {
  readonly rotationDeg: 0 | 90
  readonly state: IrregularBeamState
  readonly score: IrregularLayoutScore
}

function fittingCanonicalCandidates(
  input: CanonicalReferenceCoordinatorInput,
  canonical: SingleSheetDecode
): Effect.Effect<ReadonlyArray<FittingCanonicalCandidate>, IrregularComputeErrorType> {
  return Effect.gen(function* () {
    const terminalState = canonical.terminalState
    if (terminalState === undefined) return []
    const candidates: FittingCanonicalCandidate[] = []
    for (const { rotationDeg, state } of canonicalStateOrientationsFittingSheet(
      terminalState,
      input.request.sheet
    )) {
      const score = yield* input.layoutScorer.scoreState({ sheet: input.request.sheet, state })
      candidates.push({ rotationDeg, state, score })
    }
    return candidates
  })
}

export function canonicalStateOrientationsFittingSheet(
  terminalState: IrregularBeamState,
  sheet: SheetSpec
): ReadonlyArray<{ readonly rotationDeg: 0 | 90; readonly state: IrregularBeamState }> {
  const fitting: Array<{ readonly rotationDeg: 0 | 90; readonly state: IrregularBeamState }> = []
  for (const rotationDeg of [0, 90] as const) {
    const state = terminalState.withQuarterTurnBottomLeft(rotationDeg)
    const bounds = state?.translatedCollisionBounds
    if (
      state !== undefined &&
      bounds !== undefined &&
      assertCanonicalGridLegalLayout(sheet, state.placedCollisionGeometries)
    ) {
      fitting.push({ rotationDeg, state })
    }
  }
  return fitting
}

function materializeCanonicalResult(
  input: CanonicalReferenceCoordinatorInput,
  canonical: SingleSheetDecode,
  candidate: FittingCanonicalCandidate
): MaterializedDecode | undefined {
  const stateSnapshots = orientCanonicalStateSnapshots(
    canonical.stateSnapshots,
    candidate.rotationDeg
  )
  if (stateSnapshots === undefined) return undefined
  const portfolio = canonicalPortfolioResultFrom({
    source: canonical.portfolio,
    state: candidate.state,
    score: candidate.score
  })
  return {
    placedCollisionGeometries: candidate.state.placedCollisionGeometries,
    score: candidate.score,
    unplacedPieceIds: candidate.state.unplacedPieceIds,
    diagnostics: [],
    sortedPieceIds: input.sortedPieceIds,
    stateSnapshots,
    beamWidth: input.settings.optimizer.beamWidth,
    portfolio
  }
}

/** Schema-owned materialization for a selected canonical terminal state. */
export function canonicalPortfolioResultFrom(input: {
  readonly source: IrregularPortfolioResult
  readonly state: IrregularBeamState
  readonly score: IrregularLayoutScore
}): IrregularPortfolioResult {
  return new IrregularPortfolioResult({
    status: input.source.status,
    ...(input.source.terminationReason !== undefined
      ? { terminationReason: input.source.terminationReason }
      : {}),
    source: input.source.source,
    placements: input.state.placedCollisionGeometries.map(({ placement }) => placement),
    unplacedPieceIds: input.state.unplacedPieceIds,
    score: layoutScoreSummary(input.score),
    diagnostics: input.source.diagnostics
  })
}

export function orientCanonicalStateSnapshots(
  snapshots: ReadonlyArray<IrregularStateSnapshot>,
  rotationDeg: 0 | 90
): ReadonlyArray<IrregularStateSnapshot> | undefined {
  const oriented: IrregularStateSnapshot[] = []
  for (const snapshot of snapshots) {
    const state = snapshot.state.withQuarterTurnBottomLeft(rotationDeg)
    if (state === undefined) return undefined
    oriented.push({ ...snapshot, state })
  }
  return oriented
}

export function isCanonicalReferenceRoleEligible(
  request: NestingRequest,
  settings: IrregularNestingSettings
): boolean {
  const optimizer = settings.optimizer
  const gaDisabled =
    optimizer.gaEnabled === false ||
    optimizer.baselineOnly === true ||
    optimizer.gaTimeBudgetMs === 0 ||
    (optimizer.gaGenerationBudget ?? 4) === 0 ||
    (optimizer.gaEvaluationBudget ?? 128) === 0
  return (
    request.pieces.length > 20 &&
    (optimizer.localRepairBudget ?? 0) === 0 &&
    gaDisabled &&
    optimizer.placementPolicyId !== 'short-side-fill'
  )
}

/** Exact one/two-decode plan used by the outer coordinator. */
export function canonicalReferenceDecodeSheets(
  request: NestingRequest,
  settings: IrregularNestingSettings
): ReadonlyArray<SheetSpec> {
  if (!isCanonicalReferenceRoleEligible(request, settings) || isCanonicalReferenceSheet(request.sheet)) {
    return [request.sheet]
  }
  return [request.sheet, CANONICAL_REFERENCE_SHEET]
}

function isCanonicalReferenceSheet(sheet: SheetSpec): boolean {
  return sheet.width === CANONICAL_REFERENCE_SHEET.width && sheet.height === CANONICAL_REFERENCE_SHEET.height
}

export interface CanonicalAdmissionDecision {
  readonly admitted: boolean
  readonly reason: string
}

export function evaluateCanonicalReferenceAdmission(input: {
  readonly productionScore: IrregularLayoutScore
  readonly productionPlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly canonicalScore: IrregularLayoutScore
  readonly canonicalPlaced: ReadonlyArray<IrregularPlacedPiece>
}): CanonicalAdmissionDecision {
  const productionTopology = measureCanonicalLayoutTopology(input.productionPlaced)
  const canonicalTopology = measureCanonicalLayoutTopology(input.canonicalPlaced)
  const productionIdentity = canonicalCollisionLayoutIdentity(input.productionPlaced)
  const canonicalIdentity = canonicalCollisionLayoutIdentity(input.canonicalPlaced)
  if (
    productionTopology === undefined ||
    canonicalTopology === undefined ||
    productionIdentity === undefined ||
    canonicalIdentity === undefined ||
    !finiteAdmissionScores(input.productionScore) ||
    !finiteAdmissionScores(input.canonicalScore)
  ) {
    return { admitted: false, reason: 'protected topology or canonical identity is undefined' }
  }
  if (productionIdentity === canonicalIdentity) {
    return { admitted: false, reason: 'canonical identity tie retains production' }
  }
  return evaluateCanonicalReferenceAdmissionMetrics({
    production: input.productionScore,
    productionTopology,
    canonical: input.canonicalScore,
    canonicalTopology
  })
}

export function evaluateCanonicalReferenceAdmissionMetrics(input: {
  readonly production: IrregularLayoutScore
  readonly productionTopology: CanonicalLayoutTopology
  readonly canonical: IrregularLayoutScore
  readonly canonicalTopology: CanonicalLayoutTopology
}): CanonicalAdmissionDecision {
  if (!finiteAdmissionScores(input.production) || !finiteAdmissionScores(input.canonical)) {
    return { admitted: false, reason: 'protected score is undefined or non-finite' }
  }
  const violation = firstAdmissionViolation(
    input.production,
    input.productionTopology,
    input.canonical,
    input.canonicalTopology
  )
  return violation === undefined
    ? { admitted: true, reason: 'canonical role passed every exact admission guard' }
    : { admitted: false, reason: violation }
}

function firstAdmissionViolation(
  production: IrregularLayoutScore,
  productionTopology: CanonicalLayoutTopology,
  canonical: IrregularLayoutScore,
  canonicalTopology: CanonicalLayoutTopology
): string | undefined {
  const productionMaxSide = maxCollisionBoundsSide(production)
  const canonicalMaxSide = maxCollisionBoundsSide(canonical)
  const checks: ReadonlyArray<readonly [boolean, string]> = [
    [canonical.unplacedCount <= production.unplacedCount, 'unplaced count regressed'],
    [canonical.collisionBoundsAreaMm2 < production.collisionBoundsAreaMm2, 'area was not strictly smaller'],
    [canonical.freeMaterialHoleCount <= production.freeMaterialHoleCount, 'hole count regressed'],
    [
      canonicalTopology.largestOccupiedHullGapRatio <=
        productionTopology.largestOccupiedHullGapRatio,
      'largest occupied-hull gap regressed'
    ],
    [
      canonicalTopology.positiveContactComponentCount <=
        productionTopology.positiveContactComponentCount,
      'contact component count regressed'
    ],
    [canonicalTopology.isolatedPieceCount <= productionTopology.isolatedPieceCount, 'isolated count regressed'],
    [
      canonicalTopology.largestPositiveContactComponentSize >=
        productionTopology.largestPositiveContactComponentSize,
      'largest contact component regressed'
    ],
    [canonical.collisionBoundsSpanMm <= production.collisionBoundsSpanMm, 'span regressed'],
    [
      canonicalMaxSide <=
        productionMaxSide *
          (1 + CANONICAL_REFERENCE_ADMISSION_SLACKS.maximumMaxSideRegressionRatio),
      'max side exceeded the protected-role admission slack'
    ],
    [
      canonical.nearCompleteStructuralContactCount >=
        production.nearCompleteStructuralContactCount -
          CANONICAL_REFERENCE_ADMISSION_SLACKS.maximumTotalContactLoss,
      'total contacts exceeded the protected-role admission slack'
    ],
    [
      canonical.dominantNearCompleteStructuralContactCount >=
        production.dominantNearCompleteStructuralContactCount -
          CANONICAL_REFERENCE_ADMISSION_SLACKS.maximumDominantContactLoss,
      'dominant contacts exceeded the protected-role admission slack'
    ]
  ]
  return checks.find(([passes]) => !passes)?.[1]
}

function maxCollisionBoundsSide(score: IrregularLayoutScore): number {
  const span = score.collisionBoundsSpanMm
  const area = score.collisionBoundsAreaMm2
  const discriminant = Math.max(0, span * span - 4 * area)
  return (span + Math.sqrt(discriminant)) / 2
}

function finiteAdmissionScores(score: IrregularLayoutScore): boolean {
  return [
    score.collisionBoundsAreaMm2,
    score.collisionBoundsSpanMm,
    score.freeMaterialHoleCount,
    score.nearCompleteStructuralContactCount,
    score.dominantNearCompleteStructuralContactCount
  ].every(Number.isFinite)
}

function layoutScoreSummary(score: IrregularLayoutScore): IrregularLayoutScoreSummary {
  return new IrregularLayoutScoreSummary({
    unplacedCount: score.unplacedCount,
    sharedCollisionBoundaryLengthMm: score.sharedCollisionBoundaryLengthMm,
    sharedCollisionBoundaryContactUnits: score.sharedCollisionBoundaryContactUnits,
    sharedCollisionBoundaryContactBand: score.sharedCollisionBoundaryContactBand,
    nearCompleteStructuralContactCount: score.nearCompleteStructuralContactCount,
    dominantNearCompleteStructuralContactCount: score.dominantNearCompleteStructuralContactCount,
    largestNetFreeMaterialRegionAreaMm2: score.largestNetFreeMaterialRegionAreaMm2,
    freeMaterialRegionCount: score.freeMaterialRegionCount,
    freeMaterialHoleCount: score.freeMaterialHoleCount,
    freeMaterialSliverMetric: score.freeMaterialSliverMetric,
    collisionBoundsWorstNormalizedSheetConsumption:
      score.collisionBoundsWorstNormalizedSheetConsumption,
    collisionBoundsNormalizedSpanSum: score.collisionBoundsNormalizedSpanSum,
    collisionBoundsAreaMm2: score.collisionBoundsAreaMm2,
    collisionBoundsSpanMm: score.collisionBoundsSpanMm
  })
}

function combinePortfolioMetrics(
  first: IrregularPortfolioMetrics | undefined,
  second: IrregularPortfolioMetrics | undefined
): IrregularPortfolioMetrics | undefined {
  if (first === undefined) return second
  if (second === undefined) return first
  return {
    scheduledEvaluationSlots: first.scheduledEvaluationSlots + second.scheduledEvaluationSlots,
    distinctChromosomeKeys: first.distinctChromosomeKeys + second.distinctChromosomeKeys,
    evaluatedChromosomeCacheHits:
      first.evaluatedChromosomeCacheHits + second.evaluatedChromosomeCacheHits,
    evaluatedChromosomeCacheMisses:
      first.evaluatedChromosomeCacheMisses + second.evaluatedChromosomeCacheMisses,
    actualFullBeamDecodes: first.actualFullBeamDecodes + second.actualFullBeamDecodes,
    decodedBeamElapsedMs: first.decodedBeamElapsedMs + second.decodedBeamElapsedMs,
    decodedBeamCandidateCount:
      first.decodedBeamCandidateCount + second.decodedBeamCandidateCount
  }
}

function canonicalRoleDiagnostic(
  status: 'attempted' | 'admitted' | 'rejected' | 'selected',
  message: string
): CollisionGeometryDiagnostic {
  return new CollisionGeometryDiagnostic({
    code: `canonical_reference_role_${status}`,
    message
  })
}

/**
 * Preserves contact metrics measured on the selected search geometry.
 *
 * Final reconstruction intentionally rebuilds each source polygon at its
 * absolute terminal transform. Reapplying a uniform bottom-left translation
 * can change floating-point cancellation, while evaluating a derived angle
 * after a rigid quarter-turn can produce a numerically different but
 * geometrically equivalent polygon. Exact collinearity must therefore remain
 * authoritative from the selected beam state, while bounds and free-material
 * diagnostics still come from the public reconstructed geometry.
 */
export function preservePortfolioContactMetrics(
  reconstructed: IrregularLayoutScore,
  portfolio: IrregularLayoutScoreSummary | undefined
): IrregularLayoutScore {
  if (
    portfolio?.sharedCollisionBoundaryLengthMm === undefined ||
    portfolio.sharedCollisionBoundaryContactUnits === undefined ||
    portfolio.sharedCollisionBoundaryContactBand === undefined ||
    portfolio.nearCompleteStructuralContactCount === undefined ||
    portfolio.dominantNearCompleteStructuralContactCount === undefined
  ) {
    return reconstructed
  }

  return {
    ...reconstructed,
    sharedCollisionBoundaryLengthMm: portfolio.sharedCollisionBoundaryLengthMm,
    sharedCollisionBoundaryContactUnits: portfolio.sharedCollisionBoundaryContactUnits,
    sharedCollisionBoundaryContactBand: portfolio.sharedCollisionBoundaryContactBand,
    nearCompleteStructuralContactCount: portfolio.nearCompleteStructuralContactCount,
    dominantNearCompleteStructuralContactCount:
      portfolio.dominantNearCompleteStructuralContactCount
  }
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
