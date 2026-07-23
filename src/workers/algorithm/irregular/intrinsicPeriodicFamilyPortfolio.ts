import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularTransform,
  type IrregularPreparedPiece
} from '@shared/irregular/domain.js'
import {
  enumerateIntrinsicPeriodicCells,
  enumerateIntrinsicPeriodicCellCrops,
  nonDominatedIntrinsicPeriodicSeeds,
  rankIntrinsicPeriodicSeeds,
  selectIntrinsicPeriodicSeedFront,
  type IntrinsicPeriodicCatalog,
  type IntrinsicPeriodicBasisProvenance,
  type IntrinsicPeriodicSeed
} from './intrinsicPeriodicCells.js'
import {
  constructIntrinsicStrictState,
  finalizeIntrinsicStrictState,
  intrinsicStrictPhaseCoverageComplete,
  rankIntrinsicStrictCompletedLayouts,
  type IntrinsicStrictCandidateStatePhaseTimings,
  type IntrinsicStrictCompletedMetrics,
  type IntrinsicStrictConstructResult,
  type IntrinsicStrictDecodeResult,
  type IntrinsicStrictDecoderError
} from './intrinsicStrictDecoder.js'
import {
  IrregularGeometryInputError,
  type IrregularNfpIfpControl,
  type IrregularNestingNotImplementedError,
  type IrregularNfpIfpControlAbortError,
  type NfpIfpService
} from '../../irregular/services.js'
import type { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import { groupIntrinsicCollisionFamilies } from './intrinsicStrictFamilyPortfolio.js'
import {
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalLayoutTopology
} from '../../irregular/canonicalLayoutGeometry.js'

export interface IntrinsicPeriodicContinuation {
  readonly sourceId: string
  readonly role: 'P1' | 'P2'
  readonly familyKey: string
  readonly cellKey: string
  readonly basisSourceKey: string | undefined
  readonly seed: IntrinsicPeriodicSeed
}

export interface IntrinsicPeriodicContinuationResult {
  readonly continuation: IntrinsicPeriodicContinuation
  readonly status:
    | IntrinsicStrictDecodeResult['status']
    | 'invalid'
    | 'deadline'
    | 'global-deadline'
    | 'evaluation-cap'
  readonly result: IntrinsicStrictDecodeResult | undefined
  readonly constructed: IntrinsicStrictConstructResult | undefined
  readonly reason: string | undefined
  readonly runtimeMs: number
}

export interface IntrinsicPeriodicContinuationOmission {
  readonly sourceId: string
  readonly reason: 'insufficient-seed' | 'duplicate-canonical-seed' | 'continuation-cap'
}

/** Records one retained source's survival through crop and continuation selection. */
export interface IntrinsicPeriodicSourceCropSurvival {
  readonly role: 'P1' | 'P2'
  readonly sourceKey: string
  readonly sourceKind: IntrinsicPeriodicBasisProvenance['sourceKind']
  readonly retainedCellCount: number
  readonly directValidCropCountBeforeFront: number
  readonly directValidCropCount: number
  readonly cropFrontCount: number
  readonly uniqueSeedCount: number
  readonly selectedContinuationCount: number
}

/** Records one best raw crop that existed before periodic cell/crop retention. */
export interface IntrinsicPeriodicSourceAuditWitness {
  readonly role: 'P1' | 'P2'
  readonly familyKey: string
  readonly sourceKey: string
  readonly sourceKind: IntrinsicPeriodicBasisProvenance['sourceKind']
  readonly cellKey: string
  readonly basisProvenance: IntrinsicPeriodicBasisProvenance
  /** Preserves the exact finite crop so an immutable report can replay and render it. */
  readonly placements: ReadonlyArray<IrregularPlacedPiece>
  readonly seed: Pick<
    IntrinsicPeriodicSeed,
    | 'canonicalKey'
    | 'componentCount'
    | 'isolatedPieceCount'
    | 'largestComponentSize'
    | 'maximumSideMm'
    | 'envelopeAreaMm2'
    | 'envelopeSpanMm'
    | 'crop'
  >
}

export interface IntrinsicPeriodicSourceAuditReplay {
  readonly witnesses: ReadonlyArray<IntrinsicPeriodicSourceAuditWitness>
  readonly nonDominatedCropCount: number
  readonly sourceCropSurvival: ReadonlyArray<IntrinsicPeriodicSourceCropSurvival>
}

export type IntrinsicPeriodicSourceAuditScope = 'all' | 'p2-axis-union'

export interface IntrinsicPeriodicSourceAuditReplayEnvelope {
  readonly formatVersion: 2
  readonly algorithmVersion: 'intrinsic-periodic-source-audit-v2'
  readonly scope: IntrinsicPeriodicSourceAuditScope
  readonly preparedInputDigest: string
  readonly eligibleSourceDomainDigest: string
  readonly replayDigest: string
  readonly replay: IntrinsicPeriodicSourceAuditReplay
}

export interface IntrinsicPeriodicFamilyPortfolioResult {
  readonly catalog: IntrinsicPeriodicCatalog
  readonly continuations: ReadonlyArray<IntrinsicPeriodicContinuation>
  readonly continuationOmissions: ReadonlyArray<IntrinsicPeriodicContinuationOmission>
  readonly continuationCoverageComplete: boolean
  readonly continuationExecutionCoverageComplete?: boolean
  readonly continuationBudgetSettlementComplete?: boolean
  readonly sourceCropSurvival: ReadonlyArray<IntrinsicPeriodicSourceCropSurvival>
  readonly sourceAuditWitnesses: ReadonlyArray<IntrinsicPeriodicSourceAuditWitness>
  readonly sourceAuditNonDominatedCropCount: number
  readonly sourceAuditReplayAccepted: boolean
  readonly sourceAuditReplayRejectionReason?: string
  readonly sourceAuditReplayEnvelope?: IntrinsicPeriodicSourceAuditReplayEnvelope
  readonly runs: ReadonlyArray<IntrinsicPeriodicContinuationResult>
  readonly archive: ReadonlyArray<IntrinsicStrictCompletedMetrics>
  readonly winner: IntrinsicPeriodicContinuationResult | undefined
  readonly phaseTimings?: IntrinsicPeriodicPortfolioPhaseTimings
  readonly runtimeMs: number
}

export interface IntrinsicPeriodicPortfolioPhaseTimings {
  readonly catalogMs: number
  readonly selectionMs: number
  readonly selection: {
    readonly sourceAuditCropEnumerationMs: number
    readonly retainedCropEnumerationMs: number
    readonly cropFrontSelectionMs: number
    readonly sourceAuditLogicalCropAttemptCount: number
    readonly sourceAuditPhysicalCropAttemptCount: number
    readonly sourceAuditUniqueCanonicalCellCount: number
    readonly sourceAuditCanonicalCellReplayCount: number
    readonly sourceAuditReplayWitnessCount: number
    readonly bookkeepingMs: number
    readonly coverageComplete: boolean
    readonly totalMs: number
  }
  readonly executionOrderingMs: number
  readonly constructionMs: number
  readonly construction: {
    readonly candidateGenerationMs: number
    readonly candidateStateScoringMs: number
    readonly candidateStateScoring: IntrinsicStrictCandidateStatePhaseTimings
    readonly bookkeepingMs: number
    readonly measuredRunCount: number
    readonly expectedRunCount: number
    readonly coverageComplete: boolean
    readonly totalMs: number
  }
  readonly finalizationMs: number
  readonly archiveRankingMs: number
  readonly bookkeepingMs: number
  readonly coverageComplete: boolean
  readonly totalMs: number
}

export interface IntrinsicPeriodicFamilyPortfolioOptions {
  readonly maximumCatalogRuntimeMs?: number
  readonly maximumCellsPerFamilyRole?: number
  readonly maximumCropsPerCell?: number
  readonly maximumContinuationRuntimeMs?: number
  readonly maximumContinuationCandidateEvaluations?: number
  readonly maximumContinuationCount?: number
  readonly maximumTotalRuntimeMs?: number
  /** Enables benchmark-only nested wall-time telemetry. */
  readonly capturePhaseTimings?: boolean
  readonly control?: IrregularNfpIfpControl
  /** Restricts an experiment to one rational NFP-derived shared-basis source. */
  readonly basisSourceKey?: string
  /** Enables a bounded observer over raw source cells without changing continuations. */
  readonly captureSourceSurvivalAudit?: boolean
  /**
   * Lets the bounded raw-crop Pareto witnesses compete as source-tagged
   * continuations in the shared archive. Requires the source-survival audit;
   * without this flag the best raw witnesses exist only as diagnostics even
   * when every retained cell front evicted them.
   */
  readonly admitSourceAuditWitnesses?: boolean
  /** Replays a bounded raw-crop product only after validating its complete algorithm-owned envelope. */
  readonly sourceAuditReplayEnvelope?: IntrinsicPeriodicSourceAuditReplayEnvelope
  /** Narrows the experimental cold audit while preserving the same downstream selection. */
  readonly sourceAuditScope?: IntrinsicPeriodicSourceAuditScope
}

type PortfolioError =
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError

/** Runs independent repeated-family P1/P2 seeds through the unchanged strict decoder and archive. */
export function runIntrinsicPeriodicFamilyPortfolio(
  archiveSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  options: IntrinsicPeriodicFamilyPortfolioOptions = {}
): Effect.Effect<
  IntrinsicPeriodicFamilyPortfolioResult,
  PortfolioError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const maximumCatalogRuntimeMs = options.maximumCatalogRuntimeMs ?? 15_000
    const maximumCellsPerFamilyRole = options.maximumCellsPerFamilyRole ?? 16
    const maximumCropsPerCell = options.maximumCropsPerCell ?? 4
    const maximumContinuationRuntimeMs = options.maximumContinuationRuntimeMs ?? 25_000
    const maximumContinuationCandidateEvaluations = options.maximumContinuationCandidateEvaluations
    const capturePhaseTimings = options.capturePhaseTimings === true
    const maximumContinuationCount = options.maximumContinuationCount ?? 8
    const maximumTotalRuntimeMs = options.maximumTotalRuntimeMs ?? 240_000
    const catalogStartedAt = capturePhaseTimings ? performance.now() : 0
    const catalog = yield* enumerateIntrinsicPeriodicCells(pieces, {
      maximumRuntimeMs: maximumCatalogRuntimeMs,
      maximumFamilyCount: 8,
      maximumTransformsPerFamily: 16,
      maximumPairsPerFamily: 120,
      maximumCellsPerFamilyRole,
      captureSourceSurvivalAudit: options.captureSourceSurvivalAudit ?? false,
      ...(options.control === undefined ? {} : { control: options.control })
    })
    const catalogMs = capturePhaseTimings ? performance.now() - catalogStartedAt : 0
    const sourceAuditScope = options.sourceAuditScope ?? 'all'
    const replayProbeStartedAt = performance.now()
    const sourceAuditReplayResolution = yield* validateSourceAuditReplayEnvelope(
      catalog,
      pieces,
      sourceAuditScope,
      options.sourceAuditReplayEnvelope
    )
    const sourceAuditReplay = sourceAuditReplayResolution.replay
    const replayProbeExcludedMs =
      options.sourceAuditReplayEnvelope !== undefined && sourceAuditReplay === undefined
        ? performance.now() - replayProbeStartedAt
        : 0
    const selected = yield* selectIntrinsicPeriodicContinuations(
      catalog,
      pieces,
      maximumContinuationCount,
      maximumCropsPerCell,
      options.basisSourceKey,
      options.captureSourceSurvivalAudit ?? false,
      (options.captureSourceSurvivalAudit ?? false) && (options.admitSourceAuditWitnesses ?? false),
      capturePhaseTimings,
      sourceAuditReplay,
      sourceAuditScope,
      options.control
    )
    const selectionMs = selected.phaseTimings?.totalMs ?? 0
    const orderingStartedAt = capturePhaseTimings ? performance.now() : 0
    const continuations = continuationsForExecution(
      selected.continuations,
      maximumContinuationCandidateEvaluations
    )
    const executionOrderingMs = capturePhaseTimings ? performance.now() - orderingStartedAt : 0
    const runs: IntrinsicPeriodicContinuationResult[] = []
    let constructionMs = 0
    let constructionCandidateGenerationMs = 0
    let constructionCandidateStateScoringMs = 0
    const constructionCandidateStateScoring = emptyCandidateStatePhaseTimings()
    let constructionMeasuredRunCount = 0
    let constructionRunCoverageComplete = true
    let finalizationMs = 0
    for (const continuation of continuations) {
      const remainingMs =
        maximumTotalRuntimeMs - (performance.now() - startedAt - replayProbeExcludedMs)
      if (remainingMs <= 0) {
        runs.push({
          continuation,
          status: 'global-deadline',
          result: undefined,
          constructed: undefined,
          reason: 'global periodic portfolio runtime exhausted before continuation',
          runtimeMs: 0
        })
        continue
      }
      const startedContinuationAt = performance.now()
      const constructed = yield* Effect.matchEffect(
        constructIntrinsicStrictState({
          allPreparedPieces: pieces,
          remainingPreparedPieces: remainingAfterSeed(pieces, continuation.seed),
          frozenPlaced: continuation.seed.placements,
          candidateMode: 'pure-growth',
          maximumRuntimeMs: Math.min(maximumContinuationRuntimeMs, remainingMs),
          ...(options.control === undefined ? {} : { control: options.control }),
          ...(maximumContinuationCandidateEvaluations === undefined
            ? {}
            : { maximumCandidateEvaluationCount: maximumContinuationCandidateEvaluations }),
          ...(capturePhaseTimings ? { capturePhaseTimings: true } : {})
        }),
        {
          onFailure: (error) => Effect.succeed({ kind: 'failure' as const, error }),
          onSuccess: (value) => Effect.succeed({ kind: 'success' as const, value })
        }
      )
      const runtimeMs = performance.now() - startedContinuationAt
      if (capturePhaseTimings) constructionMs += runtimeMs
      if (constructed.kind === 'failure') {
        if (
          constructed.error._tag === 'IrregularNfpIfpControlAbortError' &&
          constructed.error.reason === 'cancelled'
        ) {
          return yield* Effect.fail(constructed.error)
        }
        runs.push({
          continuation,
          status:
            constructed.error._tag === 'IrregularNfpIfpControlAbortError' ? 'deadline' : 'invalid',
          result: undefined,
          constructed: undefined,
          reason: constructed.error._tag,
          runtimeMs
        })
        continue
      }
      if (capturePhaseTimings) {
        const constructionTiming = constructed.value.phaseTimings
        if (constructionTiming === undefined) {
          constructionRunCoverageComplete = false
        } else {
          constructionMeasuredRunCount += 1
          constructionCandidateGenerationMs += constructionTiming.candidateGenerationMs
          constructionCandidateStateScoringMs += constructionTiming.candidateStateScoringMs
          addCandidateStatePhaseTimings(
            constructionCandidateStateScoring,
            constructionTiming.candidateStateScoring
          )
          constructionRunCoverageComplete =
            constructionRunCoverageComplete && constructionTiming.coverageComplete
        }
      }
      if (constructed.value.truncationReason === 'maximum-candidate-evaluations') {
        runs.push({
          continuation,
          status: 'evaluation-cap',
          result: undefined,
          constructed: constructed.value,
          reason: constructed.value.truncationReason,
          runtimeMs
        })
        continue
      }
      const finalizationStartedAt = capturePhaseTimings ? performance.now() : 0
      const result = yield* finalizeIntrinsicStrictState(archiveSheet, constructed.value, runtimeMs)
      if (capturePhaseTimings) finalizationMs += performance.now() - finalizationStartedAt
      runs.push({
        continuation,
        status: result.status,
        result,
        constructed: constructed.value,
        reason: undefined,
        runtimeMs
      })
    }
    const archiveStartedAt = capturePhaseTimings ? performance.now() : 0
    const archive = rankIntrinsicStrictCompletedLayouts(
      runs.flatMap((run) => (run.result?.metrics === undefined ? [] : [run.result.metrics]))
    )
    const archiveRankingMs = capturePhaseTimings ? performance.now() - archiveStartedAt : 0
    const winningHash = archive[0]?.canonicalGeometryHash
    const winner =
      winningHash === undefined
        ? undefined
        : runs.find((run) => run.result?.metrics?.canonicalGeometryHash === winningHash)
    const phaseTimings =
      capturePhaseTimings && selected.phaseTimings !== undefined
        ? (() => {
            const totalMs = performance.now() - startedAt
            const measuredPhaseMs =
              catalogMs +
              selectionMs +
              executionOrderingMs +
              constructionMs +
              finalizationMs +
              archiveRankingMs
            const bookkeepingMs = Math.max(0, totalMs - measuredPhaseMs)
            const constructionBookkeepingMs = Math.max(
              0,
              constructionMs -
                constructionCandidateGenerationMs -
                constructionCandidateStateScoringMs
            )
            const constructionCoverageComplete =
              constructionRunCoverageComplete &&
              constructionMeasuredRunCount === continuations.length &&
              intrinsicStrictPhaseCoverageComplete(
                constructionMs,
                constructionBookkeepingMs
              )
            return {
              catalogMs,
              selectionMs,
              selection: selected.phaseTimings,
              executionOrderingMs,
              constructionMs,
              construction: {
                candidateGenerationMs: constructionCandidateGenerationMs,
                candidateStateScoringMs: constructionCandidateStateScoringMs,
                candidateStateScoring: freezeCandidateStatePhaseTimings(
                  constructionCandidateStateScoring
                ),
                bookkeepingMs: constructionBookkeepingMs,
                measuredRunCount: constructionMeasuredRunCount,
                expectedRunCount: continuations.length,
                coverageComplete: constructionCoverageComplete,
                totalMs: constructionMs
              },
              finalizationMs,
              archiveRankingMs,
              bookkeepingMs,
              coverageComplete:
                phaseResidualCoverageComplete(totalMs, bookkeepingMs) &&
                selected.phaseTimings.coverageComplete &&
                constructionCoverageComplete,
              totalMs
            }
          })()
        : undefined
    return {
      catalog,
      continuations,
      continuationOmissions: selected.omissions,
      continuationCoverageComplete: selected.coverageComplete,
      ...(!capturePhaseTimings
        ? {}
        : {
            continuationExecutionCoverageComplete: runs.every(
              ({ status }) =>
                status !== 'invalid' &&
                status !== 'deadline' &&
                status !== 'global-deadline' &&
                status !== 'evaluation-cap'
            ),
            continuationBudgetSettlementComplete: runs.every(
              ({ status }) =>
                status !== 'invalid' && status !== 'deadline' && status !== 'global-deadline'
            )
          }),
      sourceCropSurvival: selected.sourceCropSurvival,
      sourceAuditWitnesses: selected.sourceAuditWitnesses,
      sourceAuditNonDominatedCropCount: selected.sourceAuditNonDominatedCropCount,
      sourceAuditReplayAccepted: sourceAuditReplay !== undefined,
      ...(sourceAuditReplayResolution.rejectionReason === undefined
        ? {}
        : { sourceAuditReplayRejectionReason: sourceAuditReplayResolution.rejectionReason }),
      ...(!(options.captureSourceSurvivalAudit ?? false)
        ? {}
        : {
            sourceAuditReplayEnvelope: makeSourceAuditReplayEnvelope(
              catalog,
              pieces,
              sourceAuditScope,
              {
                witnesses: selected.sourceAuditWitnesses,
                nonDominatedCropCount: selected.sourceAuditNonDominatedCropCount,
                sourceCropSurvival: selected.sourceCropSurvival
              }
            )
          }),
      runs,
      archive,
      winner,
      ...(phaseTimings === undefined ? {} : { phaseTimings }),
      runtimeMs: phaseTimings?.totalMs ?? performance.now() - startedAt
    }
  })
}

interface MutableCandidateStatePhaseTimings {
  placementObjectMs: number
  statePlacementMs: number
  statePlacement: {
    canonicalEntryKeyMs: number
    spatialIndexMs: number
    contactMeasurementMs: number
    stateAssemblyMs: number
    bookkeepingMs: number
    totalMs: number
  }
  bottomLeftAnchoringMs: number
  envelopeScoringMs: number
  gapClassificationMs: number
  scoreBookkeepingMs: number
  candidateSelectionMs: number
  bookkeepingMs: number
  coverageComplete: boolean
  totalMs: number
}

function emptyCandidateStatePhaseTimings(): MutableCandidateStatePhaseTimings {
  return {
    placementObjectMs: 0,
    statePlacementMs: 0,
    statePlacement: {
      canonicalEntryKeyMs: 0,
      spatialIndexMs: 0,
      contactMeasurementMs: 0,
      stateAssemblyMs: 0,
      bookkeepingMs: 0,
      totalMs: 0
    },
    bottomLeftAnchoringMs: 0,
    envelopeScoringMs: 0,
    gapClassificationMs: 0,
    scoreBookkeepingMs: 0,
    candidateSelectionMs: 0,
    bookkeepingMs: 0,
    coverageComplete: true,
    totalMs: 0
  }
}

function addCandidateStatePhaseTimings(
  target: MutableCandidateStatePhaseTimings,
  source: IntrinsicStrictCandidateStatePhaseTimings
): void {
  target.placementObjectMs += source.placementObjectMs
  target.statePlacementMs += source.statePlacementMs
  target.statePlacement.canonicalEntryKeyMs += source.statePlacement.canonicalEntryKeyMs
  target.statePlacement.spatialIndexMs += source.statePlacement.spatialIndexMs
  target.statePlacement.contactMeasurementMs += source.statePlacement.contactMeasurementMs
  target.statePlacement.stateAssemblyMs += source.statePlacement.stateAssemblyMs
  target.statePlacement.bookkeepingMs += source.statePlacement.bookkeepingMs
  target.statePlacement.totalMs += source.statePlacement.totalMs
  target.bottomLeftAnchoringMs += source.bottomLeftAnchoringMs
  target.envelopeScoringMs += source.envelopeScoringMs
  target.gapClassificationMs += source.gapClassificationMs
  target.scoreBookkeepingMs += source.scoreBookkeepingMs
  target.candidateSelectionMs += source.candidateSelectionMs
  target.bookkeepingMs += source.bookkeepingMs
  target.coverageComplete = target.coverageComplete && source.coverageComplete
  target.totalMs += source.totalMs
}

function freezeCandidateStatePhaseTimings(
  timings: MutableCandidateStatePhaseTimings
): IntrinsicStrictCandidateStatePhaseTimings {
  return {
    ...timings,
    statePlacement: { ...timings.statePlacement }
  }
}

/** Runs cheaper compact seeds first when execution is already evaluation-budgeted. */
export function orderPeriodicContinuationsForExecution(
  continuations: ReadonlyArray<IntrinsicPeriodicContinuation>
): ReadonlyArray<IntrinsicPeriodicContinuation> {
  return [...continuations].toSorted(
    (first, second) =>
      first.seed.envelopeAreaMm2 - second.seed.envelopeAreaMm2 ||
      first.seed.maximumSideMm - second.seed.maximumSideMm ||
      first.seed.envelopeSpanMm - second.seed.envelopeSpanMm ||
      second.seed.placements.length - first.seed.placements.length ||
      first.sourceId.localeCompare(second.sourceId)
  )
}

/** Preserves historical order unless deterministic execution budgeting is explicitly active. */
export function continuationsForExecution(
  continuations: ReadonlyArray<IntrinsicPeriodicContinuation>,
  maximumCandidateEvaluationCount: number | undefined
): ReadonlyArray<IntrinsicPeriodicContinuation> {
  return maximumCandidateEvaluationCount === undefined
    ? continuations
    : orderPeriodicContinuationsForExecution(continuations)
}

/** Requires unclassified timing residual to stay within one percent of its interval. */
export function phaseResidualCoverageComplete(totalMs: number, residualMs: number): boolean {
  return totalMs >= 0 && residualMs >= 0 && residualMs <= totalMs * 0.01
}

function selectIntrinsicPeriodicContinuations(
  catalog: IntrinsicPeriodicCatalog,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  maximumContinuationCount: number,
  maximumCropsPerCell: number,
  basisSourceKey: string | undefined,
  captureSourceSurvivalAudit: boolean,
  admitSourceAuditWitnesses = false,
  capturePhaseTimings = false,
  sourceAuditReplay: IntrinsicPeriodicSourceAuditReplay | undefined = undefined,
  sourceAuditScope: IntrinsicPeriodicSourceAuditScope = 'all',
  control: IrregularNfpIfpControl | undefined = undefined
): Effect.Effect<
  {
    readonly continuations: ReadonlyArray<IntrinsicPeriodicContinuation>
    readonly omissions: ReadonlyArray<IntrinsicPeriodicContinuationOmission>
    readonly coverageComplete: boolean
    readonly sourceCropSurvival: ReadonlyArray<IntrinsicPeriodicSourceCropSurvival>
    readonly sourceAuditWitnesses: ReadonlyArray<IntrinsicPeriodicSourceAuditWitness>
    readonly sourceAuditNonDominatedCropCount: number
    readonly phaseTimings?: IntrinsicPeriodicPortfolioPhaseTimings['selection']
  },
  IrregularGeometryInputError | IrregularNfpIfpControlAbortError
> {
  return Effect.gen(function* () {
    yield* control?.checkpoint('candidate-points') ?? Effect.void
    const selectionStartedAt = capturePhaseTimings ? performance.now() : 0
    let sourceAuditCropEnumerationMs = 0
    let retainedCropEnumerationMs = 0
    let cropFrontSelectionMs = 0
    let sourceAuditLogicalCropAttemptCount = 0
    let sourceAuditPhysicalCropAttemptCount = 0
    let sourceAuditUniqueCanonicalCellCount = 0
    let sourceAuditCanonicalCellReplayCount = 0
    let sourceAuditReplayWitnessCount = 0
    const familyMembers = new Map(
      groupIntrinsicCollisionFamilies(pieces).map((family) => [family.key, family.members])
    )
    const perFamily = new Map<string, IntrinsicPeriodicContinuation[]>()
    const seenOrdinaryFutures = new Set<string>()
    const omissions: IntrinsicPeriodicContinuationOmission[] = []
    const sourceCropSurvival = new Map<
      string,
      Omit<
        IntrinsicPeriodicSourceCropSurvival,
        | 'retainedCellCount'
        | 'directValidCropCountBeforeFront'
        | 'directValidCropCount'
        | 'cropFrontCount'
        | 'uniqueSeedCount'
        | 'selectedContinuationCount'
      > & {
        retainedCellCount: number
        directValidCropCountBeforeFront: number
        directValidCropCount: number
        cropFrontCount: number
        uniqueSeedCount: number
        selectedContinuationCount: number
      }
    >()
    const sourceAuditWitnesses = new Map<
      string,
      {
        readonly familyKey: string
        readonly basisProvenance: IntrinsicPeriodicBasisProvenance
        readonly sourceKey: string
        readonly sourceKind: IntrinsicPeriodicBasisProvenance['sourceKind']
        readonly seed: IntrinsicPeriodicSeed
      }
    >()
    const sourceAudit = (cell: IntrinsicPeriodicCatalog['cells'][number]) => {
      if (sourceAuditReplay !== undefined) return undefined
      if (!sourceAuditCellIncluded(cell, sourceAuditScope)) return undefined
      const provenance = cell.basisProvenance
      if (provenance === undefined) return undefined
      const key = `${cell.role}:${provenance.sourceKey}`
      const current = sourceCropSurvival.get(key) ?? {
        role: cell.role,
        sourceKey: provenance.sourceKey,
        sourceKind: provenance.sourceKind,
        retainedCellCount: 0,
        directValidCropCountBeforeFront: 0,
        directValidCropCount: 0,
        cropFrontCount: 0,
        uniqueSeedCount: 0,
        selectedContinuationCount: 0
      }
      sourceCropSurvival.set(key, current)
      return current
    }
    for (const family of catalog.families) {
      yield* control?.checkpoint('candidate-points') ?? Effect.void
      const members = familyMembers.get(family.familyKey)
      if (members === undefined) continue
      const continuations: IntrinsicPeriodicContinuation[] = []
      const directValidCropsByCell = new Map<string, ReadonlyArray<IntrinsicPeriodicSeed>>()
      const directValidCropsByCanonicalCell = new Map<
        string,
        { readonly crops: ReadonlyArray<IntrinsicPeriodicSeed>; readonly attemptCount: number }
      >()
      const enumerateCrops = (
        cell: IntrinsicPeriodicCatalog['cells'][number],
        phase: 'source-audit' | 'retained'
      ): Effect.Effect<
        ReadonlyArray<IntrinsicPeriodicSeed>,
        IrregularGeometryInputError | IrregularNfpIfpControlAbortError
      > =>
        Effect.gen(function* () {
          const cached = directValidCropsByCanonicalCell.get(cell.canonicalKey)
          if (cached !== undefined) {
            if (phase === 'source-audit') {
              sourceAuditLogicalCropAttemptCount += cached.attemptCount
              sourceAuditCanonicalCellReplayCount += 1
            }
            return cached.crops
          }
          let attemptCount = 0
          const enumerationStartedAt = capturePhaseTimings ? performance.now() : 0
          const crops = yield* enumerateIntrinsicPeriodicCellCrops(
            cell,
            members,
            () => {
              attemptCount += 1
            },
            control
          )
          if (capturePhaseTimings) {
            const elapsed = performance.now() - enumerationStartedAt
            if (phase === 'source-audit') sourceAuditCropEnumerationMs += elapsed
            else retainedCropEnumerationMs += elapsed
          }
          directValidCropsByCanonicalCell.set(cell.canonicalKey, { crops, attemptCount })
          if (phase === 'source-audit') {
            sourceAuditLogicalCropAttemptCount += attemptCount
            sourceAuditPhysicalCropAttemptCount += attemptCount
            sourceAuditUniqueCanonicalCellCount += 1
          }
          return crops
        })
      if (captureSourceSurvivalAudit && sourceAuditReplay === undefined) {
        for (const cell of family.sourceAuditCells ?? family.cells) {
          yield* control?.checkpoint('candidate-points') ?? Effect.void
          if (basisSourceKey !== undefined && cell.basisProvenance?.sourceKey !== basisSourceKey)
            continue
          if (!sourceAuditCellIncluded(cell, sourceAuditScope)) continue
          const audit = sourceAudit(cell)
          const directValidCrops = yield* enumerateCrops(cell, 'source-audit')
          if (audit !== undefined) audit.directValidCropCountBeforeFront += directValidCrops.length
          const provenance = cell.basisProvenance
          if (provenance !== undefined) {
            for (const seed of directValidCrops) {
              const futureKey = periodicContinuationFutureKey(pieces, seed)
              const current = sourceAuditWitnesses.get(futureKey)
              if (current === undefined || provenance.sourceKey < current.sourceKey) {
                sourceAuditWitnesses.set(futureKey, {
                  familyKey: family.familyKey,
                  basisProvenance: provenance,
                  sourceKey: provenance.sourceKey,
                  sourceKind: provenance.sourceKind,
                  seed
                })
              }
            }
          }
          directValidCropsByCell.set(periodicSourceCellKey(cell), directValidCrops)
        }
      }
      for (const cell of family.cells) {
        yield* control?.checkpoint('candidate-points') ?? Effect.void
        if (basisSourceKey !== undefined && cell.basisProvenance?.sourceKey !== basisSourceKey)
          continue
        const audit = sourceAudit(cell)
        if (audit !== undefined) audit.retainedCellCount += 1
        let directValidCrops = directValidCropsByCell.get(periodicSourceCellKey(cell))
        if (directValidCrops === undefined) {
          directValidCrops = yield* enumerateCrops(cell, 'retained')
        }
        const cropFrontStartedAt = capturePhaseTimings ? performance.now() : 0
        const crops = selectIntrinsicPeriodicSeedFront(directValidCrops, maximumCropsPerCell)
        if (capturePhaseTimings) cropFrontSelectionMs += performance.now() - cropFrontStartedAt
        if (audit !== undefined) {
          audit.directValidCropCount += directValidCrops.length
          audit.cropFrontCount += crops.length
        }
        for (const [cropIndex, seed] of crops.entries()) {
          const sourceId = `${family.familyKey}:${cell.role}:${cell.canonicalKey}:${cropIndex}`
          if (seed.placements.length < 4) {
            omissions.push({ sourceId, reason: 'insufficient-seed' })
            continue
          }
          const futureKey = periodicContinuationFutureKey(pieces, seed)
          if (seenOrdinaryFutures.has(futureKey)) {
            omissions.push({ sourceId, reason: 'duplicate-canonical-seed' })
            continue
          }
          seenOrdinaryFutures.add(futureKey)
          if (audit !== undefined) audit.uniqueSeedCount += 1
          continuations.push({
            sourceId,
            role: cell.role,
            familyKey: family.familyKey,
            cellKey: cell.canonicalKey,
            basisSourceKey: cell.basisProvenance?.sourceKey,
            seed
          })
        }
      }
      perFamily.set(family.familyKey, continuations)
    }
    if (captureSourceSurvivalAudit && sourceAuditReplay !== undefined) {
      for (const witness of sourceAuditReplay.witnesses) {
        yield* control?.checkpoint('candidate-points') ?? Effect.void
        if (basisSourceKey !== undefined && witness.sourceKey !== basisSourceKey) continue
        const members = familyMembers.get(witness.familyKey)
        if (members === undefined) continue
        const seed = yield* validateAndReconstructSourceAuditWitness(witness, members)
        sourceAuditReplayWitnessCount += 1
        sourceAuditWitnesses.set(periodicContinuationFutureKey(pieces, seed), {
          familyKey: witness.familyKey,
          basisProvenance: witness.basisProvenance,
          sourceKey: witness.sourceKey,
          sourceKind: witness.sourceKind,
          seed
        })
      }
    }
    const rawAuditFront = nonDominatedIntrinsicPeriodicSeeds(
      [...sourceAuditWitnesses.values()].map(({ seed }) => seed)
    )
    const witnessContinuations = !admitSourceAuditWitnesses
      ? []
      : rankIntrinsicPeriodicSeeds(rawAuditFront)
          .slice(0, 16)
          .flatMap((seed) => {
            const source = sourceAuditWitnesses.get(periodicContinuationFutureKey(pieces, seed))
            if (source === undefined) return []
            const sourceId = `raw-witness:${seed.role}:${source.sourceKey}:${seed.canonicalKey}`
            if (seed.placements.length < 4) {
              omissions.push({ sourceId, reason: 'insufficient-seed' })
              return []
            }
            return [
              {
                sourceId,
                role: seed.role,
                familyKey: source.familyKey,
                cellKey: seed.cellKey,
                basisSourceKey: source.sourceKey,
                seed
              }
            ]
          })
    for (const continuation of witnessContinuations) {
      const familyContinuations = perFamily.get(continuation.familyKey) ?? []
      familyContinuations.push(continuation)
      perFamily.set(continuation.familyKey, familyContinuations)
    }
    const preferredByFuture = new Map<string, IntrinsicPeriodicContinuation>()
    for (const continuation of [...perFamily.values()].flat()) {
      const futureKey = periodicContinuationFutureKey(pieces, continuation.seed)
      const current = preferredByFuture.get(futureKey)
      if (current === undefined) {
        preferredByFuture.set(futureKey, continuation)
        continue
      }
      const preferred = preferPeriodicContinuation(current, continuation)
      const duplicate = preferred === current ? continuation : current
      preferredByFuture.set(futureKey, preferred)
      omissions.push({ sourceId: duplicate.sourceId, reason: 'duplicate-canonical-seed' })
    }
    const rankedPerFamily = [...perFamily]
      .toSorted(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
      .map(([, continuations]) =>
        rankContinuations(
          continuations.filter(
            (continuation) =>
              preferredByFuture.get(periodicContinuationFutureKey(pieces, continuation.seed)) ===
              continuation
          )
        )
      )
    const reserved = rankedPerFamily.flatMap((continuations) => continuations.slice(0, 1))
    const fill = rankContinuations(
      rankedPerFamily.flatMap((continuations) => continuations.slice(1))
    )
    const all = [...reserved, ...fill]
    const selected = all.slice(0, maximumContinuationCount)
    for (const continuation of selected) {
      const sourceKey = continuation.basisSourceKey
      if (sourceKey === undefined) continue
      const audit = sourceCropSurvival.get(`${continuation.role}:${sourceKey}`)
      if (audit !== undefined) audit.selectedContinuationCount += 1
    }
    for (const continuation of all.slice(maximumContinuationCount)) {
      omissions.push({ sourceId: continuation.sourceId, reason: 'continuation-cap' })
    }
    const sourceCropSurvivalResult = (
      sourceAuditReplay?.sourceCropSurvival ?? [...sourceCropSurvival.values()]
    ).toSorted(
      (first, second) =>
        first.role.localeCompare(second.role) || first.sourceKey.localeCompare(second.sourceKey)
    )
    const sourceAuditWitnessResult = rankIntrinsicPeriodicSeeds(rawAuditFront)
      .slice(0, 16)
      .flatMap((seed) => {
        const source = sourceAuditWitnesses.get(periodicContinuationFutureKey(pieces, seed))
        return source === undefined
          ? []
          : [
              {
                role: seed.role,
                familyKey: source.familyKey,
                sourceKey: source.sourceKey,
                sourceKind: source.sourceKind,
                cellKey: seed.cellKey,
                basisProvenance: completeBasisProvenance(source.basisProvenance),
                placements: seed.placements,
                seed: {
                  canonicalKey: seed.canonicalKey,
                  componentCount: seed.componentCount,
                  isolatedPieceCount: seed.isolatedPieceCount,
                  largestComponentSize: seed.largestComponentSize,
                  maximumSideMm: seed.maximumSideMm,
                  envelopeAreaMm2: seed.envelopeAreaMm2,
                  envelopeSpanMm: seed.envelopeSpanMm,
                  crop: seed.crop
                }
              }
            ]
      })
    const phaseTimings = capturePhaseTimings
      ? (() => {
          const totalMs = performance.now() - selectionStartedAt
          const measuredMs =
            sourceAuditCropEnumerationMs + retainedCropEnumerationMs + cropFrontSelectionMs
          const bookkeepingMs = Math.max(0, totalMs - measuredMs)
          return {
            sourceAuditCropEnumerationMs,
            retainedCropEnumerationMs,
            cropFrontSelectionMs,
            sourceAuditLogicalCropAttemptCount,
            sourceAuditPhysicalCropAttemptCount,
            sourceAuditUniqueCanonicalCellCount,
            sourceAuditCanonicalCellReplayCount,
            sourceAuditReplayWitnessCount,
            bookkeepingMs,
            coverageComplete: phaseResidualCoverageComplete(totalMs, bookkeepingMs),
            totalMs
          }
        })()
      : undefined
    return {
      continuations: selected,
      omissions,
      coverageComplete: all.length <= maximumContinuationCount,
      sourceCropSurvival: sourceCropSurvivalResult,
      sourceAuditWitnesses: sourceAuditWitnessResult,
      sourceAuditNonDominatedCropCount:
        sourceAuditReplay?.nonDominatedCropCount ?? rawAuditFront.length,
      ...(phaseTimings === undefined ? {} : { phaseTimings })
    }
  })
}

function completeBasisProvenance(
  provenance: IntrinsicPeriodicBasisProvenance
): IntrinsicPeriodicBasisProvenance {
  if (provenance.sourceKind !== 'axis-union' || provenance.axis !== undefined) return provenance
  const axis = provenance.sourceKey.startsWith('x:')
    ? 'x'
    : provenance.sourceKey.startsWith('y:')
      ? 'y'
      : undefined
  return axis === undefined ? provenance : { ...provenance, axis }
}

function sourceAuditCellIncluded(
  cell: IntrinsicPeriodicCatalog['cells'][number],
  scope: IntrinsicPeriodicSourceAuditScope
): boolean {
  return (
    scope === 'all' || (cell.role === 'P2' && cell.basisProvenance?.sourceKind === 'axis-union')
  )
}

interface EligibleSourceDomainEntry {
  readonly familyKey: string
  readonly role: 'P1' | 'P2'
  readonly sourceKey: string
  readonly sourceKind: IntrinsicPeriodicBasisProvenance['sourceKind']
  readonly cellKey: string
}

function makeSourceAuditReplayEnvelope(
  catalog: IntrinsicPeriodicCatalog,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  scope: IntrinsicPeriodicSourceAuditScope,
  replay: IntrinsicPeriodicSourceAuditReplay
): IntrinsicPeriodicSourceAuditReplayEnvelope {
  return {
    formatVersion: 2,
    algorithmVersion: 'intrinsic-periodic-source-audit-v2',
    scope,
    preparedInputDigest: sourceAuditPreparedInputDigest(pieces),
    eligibleSourceDomainDigest: sourceAuditEligibleDomainDigest(catalog, scope),
    replayDigest: sourceAuditReplayDigest(replay),
    replay
  }
}

function validateSourceAuditReplayEnvelope(
  catalog: IntrinsicPeriodicCatalog,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  scope: IntrinsicPeriodicSourceAuditScope,
  envelope: IntrinsicPeriodicSourceAuditReplayEnvelope | undefined
): Effect.Effect<{
  readonly replay?: IntrinsicPeriodicSourceAuditReplay
  readonly rejectionReason?: string
}> {
  return Effect.gen(function* () {
    if (envelope === undefined) return {}
    if (envelope.formatVersion !== 2) return replayRejected('format-version')
    if (envelope.algorithmVersion !== 'intrinsic-periodic-source-audit-v2') {
      return replayRejected('algorithm-version')
    }
    if (envelope.scope !== scope) return replayRejected('scope')
    if (envelope.preparedInputDigest !== sourceAuditPreparedInputDigest(pieces)) {
      return replayRejected('prepared-input')
    }
    if (envelope.eligibleSourceDomainDigest !== sourceAuditEligibleDomainDigest(catalog, scope)) {
      return replayRejected('eligible-source-domain')
    }
    if (envelope.replayDigest !== sourceAuditReplayDigest(envelope.replay)) {
      return replayRejected('replay-digest')
    }
    if (envelope.replay.witnesses.length > 16) return replayRejected('witness-cap')

    const eligibleEntries = eligibleSourceDomainEntries(catalog, scope)
    const eligibleWitnesses = new Set(eligibleEntries.map(eligibleSourceDomainEntryKey))
    const eligibleSurvival = new Set(
      eligibleEntries.map(({ role, sourceKey, sourceKind }) =>
        sourceAuditSurvivalKey({ role, sourceKey, sourceKind })
      )
    )
    if (
      !Number.isSafeInteger(envelope.replay.nonDominatedCropCount) ||
      envelope.replay.nonDominatedCropCount < 0 ||
      envelope.replay.sourceCropSurvival.length > eligibleSurvival.size
    ) {
      return replayRejected('non-dominated-count')
    }
    const seenSurvival = new Set<string>()
    for (const survival of envelope.replay.sourceCropSurvival) {
      const key = sourceAuditSurvivalKey(survival)
      if (
        !eligibleSurvival.has(key) ||
        seenSurvival.has(key) ||
        !sourceAuditSurvivalCountsValid(survival)
      ) {
        return replayRejected('source-survival')
      }
      seenSurvival.add(key)
    }

    const familyMembers = new Map(
      groupIntrinsicCollisionFamilies(pieces).map((family) => [family.key, family.members])
    )
    const seenWitnesses = new Set<string>()
    for (const witness of envelope.replay.witnesses) {
      const witnessKey = eligibleSourceDomainEntryKey(witness)
      if (!eligibleWitnesses.has(witnessKey) || seenWitnesses.has(witness.seed.canonicalKey)) {
        return replayRejected('witness-domain')
      }
      seenWitnesses.add(witness.seed.canonicalKey)
      const members = familyMembers.get(witness.familyKey)
      if (members === undefined) return replayRejected('witness-family')
      const valid = yield* Effect.matchEffect(
        validateAndReconstructSourceAuditWitness(witness, members),
        {
          onFailure: () => Effect.succeed(false),
          onSuccess: () => Effect.succeed(true)
        }
      )
      if (!valid) return replayRejected('witness-validation')
    }
    return { replay: envelope.replay }
  })
}

function replayRejected(rejectionReason: string): {
  readonly rejectionReason: string
} {
  return { rejectionReason }
}

function sourceAuditPreparedInputDigest(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): string {
  return sha256(JSON.stringify(pieces))
}

function sourceAuditEligibleDomainDigest(
  catalog: IntrinsicPeriodicCatalog,
  scope: IntrinsicPeriodicSourceAuditScope
): string {
  return sha256(JSON.stringify(eligibleSourceDomainEntries(catalog, scope)))
}

function sourceAuditReplayDigest(replay: IntrinsicPeriodicSourceAuditReplay): string {
  return sha256(JSON.stringify(replay))
}

function eligibleSourceDomainEntries(
  catalog: IntrinsicPeriodicCatalog,
  scope: IntrinsicPeriodicSourceAuditScope
): ReadonlyArray<EligibleSourceDomainEntry> {
  return catalog.families
    .flatMap((family) =>
      (family.sourceAuditCells ?? family.cells).flatMap((cell) => {
        const provenance = cell.basisProvenance
        return provenance === undefined || !sourceAuditCellIncluded(cell, scope)
          ? []
          : [
              {
                familyKey: family.familyKey,
                role: cell.role,
                sourceKey: provenance.sourceKey,
                sourceKind: provenance.sourceKind,
                cellKey: cell.canonicalKey
              }
            ]
      })
    )
    .toSorted((first, second) =>
      eligibleSourceDomainEntryKey(first).localeCompare(eligibleSourceDomainEntryKey(second))
    )
}

function eligibleSourceDomainEntryKey(entry: EligibleSourceDomainEntry): string {
  return JSON.stringify([
    entry.familyKey,
    entry.role,
    entry.sourceKey,
    entry.sourceKind,
    entry.cellKey
  ])
}

function sourceAuditSurvivalKey(entry: {
  readonly role: 'P1' | 'P2'
  readonly sourceKey: string
  readonly sourceKind: IntrinsicPeriodicBasisProvenance['sourceKind']
}): string {
  return JSON.stringify([entry.role, entry.sourceKey, entry.sourceKind])
}

function sourceAuditSurvivalCountsValid(
  survival: IntrinsicPeriodicSourceCropSurvival
): boolean {
  return [
    survival.retainedCellCount,
    survival.directValidCropCountBeforeFront,
    survival.directValidCropCount,
    survival.cropFrontCount,
    survival.uniqueSeedCount,
    survival.selectedContinuationCount
  ].every((value) => Number.isSafeInteger(value) && value >= 0)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function validateAndReconstructSourceAuditWitness(
  witness: IntrinsicPeriodicSourceAuditWitness,
  familyMembers: ReadonlyArray<IrregularPreparedPiece>
): Effect.Effect<IntrinsicPeriodicSeed, IrregularGeometryInputError> {
  return Effect.gen(function* () {
    if (
      witness.sourceKey !== witness.basisProvenance.sourceKey ||
      witness.sourceKind !== witness.basisProvenance.sourceKind
    ) {
      return yield* invalidReplay('source-audit replay provenance does not match its seed')
    }
    const familyIds = new Set(familyMembers.map((piece) => piece.pieceId ?? piece.source.id))
    const placedIds = new Set<string>()
    for (const placed of witness.placements) {
      const pieceId = placed.placement.pieceId ?? placed.placement.sourcePieceId
      if (!familyIds.has(pieceId) || placedIds.has(pieceId)) {
        return yield* invalidReplay('source-audit replay contains an unknown or duplicate piece')
      }
      placedIds.add(pieceId)
    }
    if (!canonicalSheetlessLegal(witness.placements)) {
      return yield* invalidReplay('source-audit replay is not canonically sheetless legal')
    }
    const canonicalKey = canonicalCollisionLayoutIdentity(witness.placements)
    if (canonicalKey === undefined || canonicalKey !== witness.seed.canonicalKey) {
      return yield* invalidReplay('source-audit replay canonical identity mismatch')
    }
    const topology = measureCanonicalLayoutTopology(witness.placements)
    if (
      topology === undefined ||
      topology.positiveContactComponentCount !== witness.seed.componentCount ||
      topology.isolatedPieceCount !== witness.seed.isolatedPieceCount ||
      topology.largestPositiveContactComponentSize !== witness.seed.largestComponentSize
    ) {
      return yield* invalidReplay('source-audit replay topology mismatch')
    }
    const bounds = placedEnvelopeBounds(witness.placements)
    if (
      !sameMetric(Math.max(bounds.width, bounds.height), witness.seed.maximumSideMm) ||
      !sameMetric(bounds.width * bounds.height, witness.seed.envelopeAreaMm2) ||
      !sameMetric(bounds.width + bounds.height, witness.seed.envelopeSpanMm)
    ) {
      return yield* invalidReplay('source-audit replay envelope metric mismatch')
    }
    return {
      role: witness.role,
      cellKey: witness.cellKey,
      placements: witness.placements,
      remainingFamilyMembers: familyMembers.filter(
        (piece) => !placedIds.has(piece.pieceId ?? piece.source.id)
      ),
      componentCount: witness.seed.componentCount,
      isolatedPieceCount: witness.seed.isolatedPieceCount,
      largestComponentSize: witness.seed.largestComponentSize,
      maximumSideMm: witness.seed.maximumSideMm,
      envelopeAreaMm2: witness.seed.envelopeAreaMm2,
      envelopeSpanMm: witness.seed.envelopeSpanMm,
      crop: witness.seed.crop,
      canonicalKey: witness.seed.canonicalKey
    }
  })
}

function placedEnvelopeBounds(placed: ReadonlyArray<IrregularPlacedPiece>): {
  readonly width: number
  readonly height: number
} {
  const points = placed.flatMap(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
  const xs = points.map(({ x }) => x)
  const ys = points.map(({ y }) => y)
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys)
  }
}

function canonicalSheetlessLegal(placed: ReadonlyArray<IrregularPlacedPiece>): boolean {
  const points = placed.flatMap(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
  if (points.length === 0) return false
  const minX = Math.min(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y))
  const maxX = Math.max(...points.map(({ x }) => x))
  const maxY = Math.max(...points.map(({ y }) => y))
  const normalized = placed.map(
    ({ placement, collisionGeometry }) =>
      new IrregularPlacedPiece({
        placement: new IrregularPlacement({
          ...(placement.pieceId === undefined ? {} : { pieceId: placement.pieceId }),
          sourcePieceId: placement.sourcePieceId,
          ...(placement.placementReference === undefined
            ? {}
            : { placementReference: placement.placementReference }),
          transform: new IrregularTransform({
            translateX: placement.transform.translateX - minX,
            translateY: placement.transform.translateY - minY,
            rotationDeg: placement.transform.rotationDeg,
            mirrored: placement.transform.mirrored
          })
        }),
        collisionGeometry
      })
  )
  return assertCanonicalGridLegalLayout(
    new SheetSpec({
      width: Math.ceil(maxX - minX) + 1,
      height: Math.ceil(maxY - minY) + 1,
      label: 'source-audit replay validation'
    }),
    normalized
  )
}

function sameMetric(first: number, second: number): boolean {
  return Math.abs(first - second) <= 1e-9 * Math.max(1, Math.abs(first), Math.abs(second))
}

function invalidReplay(message: string): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(
    new IrregularGeometryInputError({
      operation: 'intrinsicPeriodicSourceAuditReplay',
      message
    })
  )
}

function periodicSourceCellKey(cell: IntrinsicPeriodicCatalog['cells'][number]): string {
  return `${cell.role}:${cell.basisProvenance?.sourceKey ?? 'unprovenanced'}:${cell.canonicalKey}`
}

function rankContinuations(
  continuations: ReadonlyArray<IntrinsicPeriodicContinuation>
): ReadonlyArray<IntrinsicPeriodicContinuation> {
  const ranks = new Map(
    rankIntrinsicPeriodicSeeds(continuations.map(({ seed }) => seed)).map((seed, index) => [
      seed.canonicalKey,
      index
    ])
  )
  return [...continuations].toSorted((first, second) => {
    const firstRank = ranks.get(first.seed.canonicalKey) ?? Number.MAX_SAFE_INTEGER
    const secondRank = ranks.get(second.seed.canonicalKey) ?? Number.MAX_SAFE_INTEGER
    return firstRank - secondRank || first.sourceId.localeCompare(second.sourceId)
  })
}

function periodicContinuationFutureKey(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  seed: IntrinsicPeriodicSeed
): string {
  const remainingOrder = remainingAfterSeed(pieces, seed).map(
    (piece) => piece.pieceId ?? piece.source.id
  )
  return JSON.stringify({ geometry: seed.canonicalKey, remainingOrder })
}

function preferPeriodicContinuation(
  first: IntrinsicPeriodicContinuation,
  second: IntrinsicPeriodicContinuation
): IntrinsicPeriodicContinuation {
  const firstIsWitness = first.sourceId.startsWith('raw-witness:')
  const secondIsWitness = second.sourceId.startsWith('raw-witness:')
  if (firstIsWitness !== secondIsWitness) return firstIsWitness ? second : first
  return first.sourceId.localeCompare(second.sourceId) <= 0 ? first : second
}

function remainingAfterSeed(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  seed: IntrinsicPeriodicSeed
): ReadonlyArray<IrregularPreparedPiece> {
  const frozen = new Set(
    seed.placements.map(({ placement }) => placement.pieceId ?? placement.sourcePieceId)
  )
  return pieces.filter((piece) => !frozen.has(piece.pieceId ?? piece.source.id))
}
