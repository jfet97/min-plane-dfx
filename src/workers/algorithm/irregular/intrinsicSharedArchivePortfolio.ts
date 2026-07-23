import { Effect } from 'effect'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type { IrregularPlacedPiece, IrregularPreparedPiece } from '@shared/irregular/domain.js'
import {
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity
} from '../../irregular/canonicalLayoutGeometry.js'
import type { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import type {
  IrregularGeometryInputError,
  IrregularNfpIfpControl,
  IrregularNestingNotImplementedError,
  IrregularNfpIfpControlAbortError,
  NfpIfpService
} from '../../irregular/services.js'
import {
  runIntrinsicPeriodicFamilyPortfolio,
  type IntrinsicPeriodicContinuationResult,
  type IntrinsicPeriodicFamilyPortfolioOptions,
  type IntrinsicPeriodicFamilyPortfolioResult
} from './intrinsicPeriodicFamilyPortfolio.js'
import { retainIntrinsicAnytimeArchiveNamespace } from './intrinsicAnytimeArchive.js'
import {
  constructIntrinsicStrictState,
  evaluateIntrinsicStrictCertificate,
  measureIntrinsicSheetlessCompletedLayout,
  rankIntrinsicStrictCompletedLayouts,
  selectIntrinsicStrictCompletedParetoFront,
  type IntrinsicStrictCandidateMode,
  type IntrinsicStrictCertificate,
  type IntrinsicStrictCompletedMetrics,
  type IntrinsicStrictConstructResult,
  type IntrinsicStrictDirectCheckpoint,
  type IntrinsicStrictDecoderError
} from './intrinsicStrictDecoder.js'
import { IrregularBeamState } from './irregularBeamState.js'
import { IntrinsicCapacityError } from './intrinsicCapacityPreflight.js'

export const INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES = [
  'canonical-grid',
  'legacy-absolute-envelope',
  'open-pocket-first'
] as const
export const INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT = 8
export const INTRINSIC_SHARED_ARCHIVE_PERIODIC_EVALUATION_CAP = 19_862

export type IntrinsicSharedArchiveDirectRole =
  (typeof INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES)[number]

export type IntrinsicSharedArchiveRunStatus =
  | 'completed'
  | 'evaluation-cap'
  | 'deadline'
  | 'global-deadline'
  | 'invalid'
  | 'incomplete'

export interface IntrinsicSharedArchiveSheetFit {
  readonly q0: IntrinsicSharedArchiveOrientationFit
  readonly q90: IntrinsicSharedArchiveOrientationFit
  readonly selectedRotationDeg: 0 | 90 | undefined
  readonly selectedCanonicalGeometryHash: string | undefined
  readonly selectedPlacedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
}

export interface IntrinsicSharedArchiveOrientationFit {
  readonly fits: boolean
  readonly canonicalGeometryHash: string | undefined
}

export interface IntrinsicSharedArchiveEndpoint {
  readonly role: string
  readonly sourceId: string | undefined
  readonly sheetlessCanonicalGeometryIdentity: string
  readonly sheetlessCanonicalGeometryHash: string
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly metrics: IntrinsicStrictCompletedMetrics
  readonly certificate: IntrinsicStrictCertificate
  readonly requestedSheetFit: IntrinsicSharedArchiveSheetFit
}

export interface IntrinsicSharedArchiveRun {
  readonly role: string
  readonly sourceId: string | undefined
  readonly status: IntrinsicSharedArchiveRunStatus
  readonly requestedCandidateEvaluations: number | undefined
  readonly consumedCandidateEvaluations: number | undefined
  readonly reason: string | undefined
  readonly endpoint: IntrinsicSharedArchiveEndpoint | undefined
  readonly runtimeMs: number
}

export interface IntrinsicSharedArchivePortfolioResult {
  readonly directRuns: ReadonlyArray<IntrinsicSharedArchiveRun>
  readonly periodicRuns: ReadonlyArray<IntrinsicSharedArchiveRun>
  readonly periodicPortfolio: IntrinsicPeriodicFamilyPortfolioResult
  readonly sheetlessArchive: ReadonlyArray<IntrinsicSharedArchiveEndpoint>
  readonly archive: ReadonlyArray<IntrinsicSharedArchiveEndpoint>
  readonly winner: IntrinsicSharedArchiveEndpoint | undefined
  readonly periodicSelectionValid: boolean
  readonly experimentValid: boolean
}

type SharedArchiveError =
  | IntrinsicStrictDecoderError
  | IntrinsicCapacityError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError

export interface IntrinsicSharedArchivePortfolioOptions {
  readonly directCandidateEvaluationCaps?: Partial<
    Readonly<Record<IntrinsicSharedArchiveDirectRole, number>>
  >
  readonly maximumDirectRuntimeMs?: number
  /** Opt-in canonical-grid pause quantum; other direct roles remain unchanged. */
  readonly canonicalGridCompletedPieceQuantum?: number
  readonly onCanonicalGridCheckpointed?: (
    checkpoint: IntrinsicStrictDirectCheckpoint
  ) => Effect.Effect<
    void,
    SharedArchiveError,
    GeometryKernel | GeometrySettings | NfpIfpService
  >
  readonly control?: IrregularNfpIfpControl
  readonly onPhaseCompleted?: (phase: 'direct' | 'periodic') => Effect.Effect<void>
  /**
   * Read-only observation of one committed, uncapped, complete direct
   * constructor state after its construction returned. Capacity prefix capture
   * uses this without changing construction, archive order, evaluations,
   * hashes, or source selection.
   */
  readonly onDirectConstructed?: (
    role: IntrinsicSharedArchiveDirectRole,
    state: IrregularBeamState
  ) => void
  /**
   * Includes bounded raw-crop Pareto witnesses in periodic continuation
   * selection so a retained-cell surrogate cannot silently remove a better
   * exact completed layout from the shared archive.
   */
  readonly includeSourceAuditWitnesses?: boolean
  readonly periodic?: Omit<
    IntrinsicPeriodicFamilyPortfolioOptions,
    | 'maximumContinuationCandidateEvaluations'
    | 'maximumContinuationCount'
    | 'captureSourceSurvivalAudit'
    | 'admitSourceAuditWitnesses'
  >
}

/** Runs the smallest protected, pocket-first, and periodic archive matrix. */
export function runIntrinsicSharedArchivePortfolio(
  sheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  options: IntrinsicSharedArchivePortfolioOptions = {}
): Effect.Effect<
  IntrinsicSharedArchivePortfolioResult,
  SharedArchiveError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const includeSourceAuditWitnesses = options.includeSourceAuditWitnesses ?? true
    const directRuns = yield* runIntrinsicSharedArchiveDirectPortfolio(sheet, pieces, {
      ...(options.directCandidateEvaluationCaps === undefined
        ? {}
        : { directCandidateEvaluationCaps: options.directCandidateEvaluationCaps }),
      ...(options.maximumDirectRuntimeMs === undefined
        ? {}
        : { maximumDirectRuntimeMs: options.maximumDirectRuntimeMs }),
      ...(options.canonicalGridCompletedPieceQuantum === undefined
        ? {}
        : {
            canonicalGridCompletedPieceQuantum:
              options.canonicalGridCompletedPieceQuantum
          }),
      ...(options.onCanonicalGridCheckpointed === undefined
        ? {}
        : {
            onCanonicalGridCheckpointed:
              options.onCanonicalGridCheckpointed
          }),
      ...(options.control === undefined ? {} : { control: options.control }),
      ...(options.onDirectConstructed === undefined
        ? {}
        : { onDirectConstructed: options.onDirectConstructed })
    })
    yield* options.onPhaseCompleted?.('direct') ?? Effect.void

    const periodicPortfolio = yield* runIntrinsicPeriodicFamilyPortfolio(
      sheet,
      pieces,
      {
        ...options.periodic,
        maximumContinuationCandidateEvaluations:
          INTRINSIC_SHARED_ARCHIVE_PERIODIC_EVALUATION_CAP,
        maximumContinuationCount: INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT,
        captureSourceSurvivalAudit: includeSourceAuditWitnesses,
        admitSourceAuditWitnesses: includeSourceAuditWitnesses,
        ...(options.control === undefined ? {} : { control: options.control })
      }
    )
    yield* options.onPhaseCompleted?.('periodic') ?? Effect.void
    const periodicRuns = periodicPortfolio.runs.map((run) =>
      normalizePeriodicRun(sheet, run, INTRINSIC_SHARED_ARCHIVE_PERIODIC_EVALUATION_CAP)
    )
    const endpoints = [...directRuns, ...periodicRuns].flatMap(({ endpoint }) =>
      endpoint === undefined ? [] : [endpoint]
    )
    const sheetlessArchive = retainRankedSharedArchive(endpoints)
    const archive = selectFittingSharedArchive(sheetlessArchive)
    const winner = selectIntrinsicSharedArchiveWinner(archive)
    const periodicSelectionValid = intrinsicSharedPeriodicSelectionValid({
      catalogRuntimeCoverageComplete: periodicPortfolio.catalog.runtimeCoverageComplete,
      continuationCoverageComplete: periodicPortfolio.continuationCoverageComplete,
      selectedContinuationCount: periodicPortfolio.continuations.length,
      runCount: periodicPortfolio.runs.length,
      budgetSettlementComplete:
        periodicPortfolio.continuationBudgetSettlementComplete === true
    })
    return {
      directRuns,
      periodicRuns,
      periodicPortfolio,
      sheetlessArchive,
      archive,
      winner,
      periodicSelectionValid,
      experimentValid: intrinsicSharedArchiveExperimentValid(
        directRuns,
        periodicRuns,
        periodicSelectionValid
      )
    }
  })
}

/** Runs the three direct roles alone so their exact completion counts can be calibrated. */
export function runIntrinsicSharedArchiveDirectPortfolio(
  sheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  options: Pick<
    IntrinsicSharedArchivePortfolioOptions,
    | 'directCandidateEvaluationCaps'
    | 'maximumDirectRuntimeMs'
    | 'canonicalGridCompletedPieceQuantum'
    | 'onCanonicalGridCheckpointed'
    | 'control'
    | 'onDirectConstructed'
  > = {}
): Effect.Effect<
  ReadonlyArray<IntrinsicSharedArchiveRun>,
  SharedArchiveError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const maximumDirectRuntimeMs = options.maximumDirectRuntimeMs ?? 600_000
    const runs: IntrinsicSharedArchiveRun[] = []
    for (const role of INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES) {
      const startedAt = performance.now()
      const requestedCandidateEvaluations = options.directCandidateEvaluationCaps?.[role]
      let checkpoint: IntrinsicStrictDirectCheckpoint | undefined
      let outcome:
        | {
            readonly kind: 'failure'
            readonly error:
              | IntrinsicStrictDecoderError
              | IrregularNestingNotImplementedError
              | IrregularGeometryInputError
              | IrregularNfpIfpControlAbortError
          }
        | { readonly kind: 'success'; readonly constructed: IntrinsicStrictConstructResult }
      while (true) {
        outcome = yield* Effect.matchEffect(
          constructIntrinsicStrictState({
            allPreparedPieces: pieces,
            remainingPreparedPieces: pieces,
            frozenPlaced: [],
            candidateMode: directCandidateMode(role),
            producerRole: role,
            maximumRuntimeMs: maximumDirectRuntimeMs,
            captureCandidateEvaluationCount: true,
            ...(options.control === undefined ? {} : { control: options.control }),
            ...(requestedCandidateEvaluations === undefined
              ? {}
              : { maximumCandidateEvaluationCount: requestedCandidateEvaluations }),
            ...(checkpoint === undefined ? {} : { checkpoint }),
            ...(role !== 'canonical-grid' ||
            options.canonicalGridCompletedPieceQuantum === undefined
              ? {}
              : {
                  maximumCompletedPieceBoundaries:
                    options.canonicalGridCompletedPieceQuantum
                })
          }),
          {
            onFailure: (error) => Effect.succeed({ kind: 'failure' as const, error }),
            onSuccess: (constructed) =>
              Effect.succeed({ kind: 'success' as const, constructed })
          }
        )
        if (
          outcome.kind !== 'success' ||
          outcome.constructed.checkpoint === undefined
        ) {
          break
        }
        checkpoint = outcome.constructed.checkpoint
        yield* options.onCanonicalGridCheckpointed?.(checkpoint) ?? Effect.void
      }
      if (outcome.kind === 'failure') {
        if (
          outcome.error._tag === 'IrregularNfpIfpControlAbortError' &&
          outcome.error.reason === 'cancelled'
        ) {
          return yield* Effect.fail(outcome.error)
        }
        runs.push({
          role,
          sourceId: undefined,
          status:
            outcome.error._tag === 'IrregularNfpIfpControlAbortError' ? 'deadline' : 'invalid',
          requestedCandidateEvaluations,
          consumedCandidateEvaluations: undefined,
          reason: outcome.error.message,
          endpoint: undefined,
          runtimeMs: Math.max(0, performance.now() - startedAt)
        })
        continue
      }
      if (
        outcome.constructed.truncationReason === undefined &&
        outcome.constructed.state.remainingPreparedPieces.length === 0 &&
        outcome.constructed.state.unplacedPieceIds.length === 0
      ) {
        options.onDirectConstructed?.(role, outcome.constructed.state)
      }
      runs.push(
        normalizeIntrinsicSharedArchiveConstructedRun({
          sheet,
          role,
          sourceId: undefined,
          requestedCandidateEvaluations,
          constructed: outcome.constructed
        })
      )
    }
    return runs
  })
}

/** Canonically deduplicates complete endpoints and applies the strict terminal rank. */
export function retainRankedSharedArchive(
  endpoints: ReadonlyArray<IntrinsicSharedArchiveEndpoint>
): ReadonlyArray<IntrinsicSharedArchiveEndpoint> {
  const rankedByHash = new Map<string, IntrinsicSharedArchiveEndpoint>()
  const retained = retainIntrinsicAnytimeArchiveNamespace({
    namespace: 'complete',
    endpoints,
    identity: ({ sheetlessCanonicalGeometryHash }) => sheetlessCanonicalGeometryHash,
    validate: ({ sheetlessCanonicalGeometryHash, metrics }) =>
      sheetlessCanonicalGeometryHash === metrics.canonicalGeometryHash,
    selectDuplicate: (first) => first,
    rank: (unique) => {
      rankedByHash.clear()
      for (const endpoint of unique) {
        rankedByHash.set(endpoint.sheetlessCanonicalGeometryHash, endpoint)
      }
      return rankIntrinsicStrictCompletedLayouts(unique.map(({ metrics }) => metrics)).flatMap(
        (metrics) => {
          const endpoint = rankedByHash.get(metrics.canonicalGeometryHash)
          return endpoint === undefined ? [] : [endpoint]
        }
      )
    }
  })
  return retained
}

/** Keeps sheetless rank order while removing endpoints that do not fit the requested sheet. */
export function selectFittingSharedArchive(
  sheetlessArchive: ReadonlyArray<IntrinsicSharedArchiveEndpoint>
): ReadonlyArray<IntrinsicSharedArchiveEndpoint> {
  return sheetlessArchive.filter(
    ({ requestedSheetFit }) => requestedSheetFit.selectedRotationDeg !== undefined
  )
}

/** Selects one cohesive winner without allowing contact to veto geometric dominance. */
export function selectIntrinsicSharedArchiveWinner(
  archive: ReadonlyArray<IntrinsicSharedArchiveEndpoint>
): IntrinsicSharedArchiveEndpoint | undefined {
  const geometricFrontHashes = new Set(
    selectIntrinsicStrictCompletedParetoFront(archive.map(({ metrics }) => metrics)).map(
      ({ canonicalGeometryHash }) => canonicalGeometryHash
    )
  )
  return archive
    .filter(({ sheetlessCanonicalGeometryHash }) =>
      geometricFrontHashes.has(sheetlessCanonicalGeometryHash)
    )
    .toSorted(compareIntrinsicSharedArchiveWinner)[0]
}

function compareIntrinsicSharedArchiveWinner(
  first: IntrinsicSharedArchiveEndpoint,
  second: IntrinsicSharedArchiveEndpoint
): number {
  return (
    first.certificate.relativeDeficitSum - second.certificate.relativeDeficitSum ||
    first.metrics.enclosedCavityCount - second.metrics.enclosedCavityCount ||
    first.metrics.largestOccupiedHullGapRatio -
      second.metrics.largestOccupiedHullGapRatio ||
    first.metrics.envelopeAreaMm2 - second.metrics.envelopeAreaMm2 ||
    first.metrics.envelopeMaximumSideMm - second.metrics.envelopeMaximumSideMm ||
    first.metrics.envelopeSpanMm - second.metrics.envelopeSpanMm ||
    first.sheetlessCanonicalGeometryHash.localeCompare(second.sheetlessCanonicalGeometryHash)
  )
}

/** Requires uncensored selection and deterministic settlement of every selected source. */
export function intrinsicSharedPeriodicSelectionValid(
  input: {
    readonly catalogRuntimeCoverageComplete: boolean
    readonly continuationCoverageComplete: boolean
    readonly selectedContinuationCount: number
    readonly runCount: number
    readonly budgetSettlementComplete: boolean
  }
): boolean {
  return (
    input.catalogRuntimeCoverageComplete &&
    input.selectedContinuationCount <= INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT &&
    input.runCount === input.selectedContinuationCount &&
    (input.continuationCoverageComplete ||
      input.selectedContinuationCount ===
        INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT) &&
    input.budgetSettlementComplete
  )
}

/** Requires direct completion; only periodic continuations may settle at their fixed cap. */
export function intrinsicSharedArchiveExperimentValid(
  directRuns: ReadonlyArray<
    Pick<
      IntrinsicSharedArchiveRun,
      'status' | 'requestedCandidateEvaluations' | 'consumedCandidateEvaluations'
    >
  >,
  periodicRuns: ReadonlyArray<Pick<IntrinsicSharedArchiveRun, 'status'>>,
  periodicSelectionValid: boolean
): boolean {
  return (
    periodicSelectionValid &&
    directRuns.every(
      ({ status, requestedCandidateEvaluations, consumedCandidateEvaluations }) =>
        status === 'completed' &&
        requestedCandidateEvaluations !== undefined &&
        requestedCandidateEvaluations === consumedCandidateEvaluations
    ) &&
    periodicRuns.every(
      ({ status }) => status === 'completed' || status === 'evaluation-cap'
    )
  )
}

/** Requires every uncapped direct role and every applicable periodic source to settle cleanly. */
export function intrinsicSharedArchiveProductionValid(
  result: IntrinsicSharedArchivePortfolioResult
): boolean {
  const directValid = result.directRuns.every(
    ({ status, endpoint }) => status === 'completed' && endpoint !== undefined
  )
  const catalog = result.periodicPortfolio.catalog
  const hasPeriodicFamilies = catalog.families.length > 0
  const catalogCoverageValid = intrinsicSharedPeriodicCatalogCoverageValid(catalog)
  return (
    directValid &&
    catalogCoverageValid &&
    (!hasPeriodicFamilies || result.periodicSelectionValid) &&
    result.periodicRuns.every(
      ({ status }) => status === 'completed' || status === 'evaluation-cap'
    )
  )
}

/** Rejects runtime censoring while allowing fully executed deterministic family/front caps. */
export function intrinsicSharedPeriodicCatalogCoverageValid(
  catalog: IntrinsicPeriodicFamilyPortfolioResult['catalog']
): boolean {
  return (
    catalog.runtimeCoverageComplete &&
    (catalog.families.length > 0 || catalog.familyCoverageComplete) &&
    catalog.families.every(
      (family) => family.cellCoverageComplete || family.sourceAuditCells !== undefined
    )
  )
}

function directCandidateMode(role: IntrinsicSharedArchiveDirectRole): IntrinsicStrictCandidateMode {
  if (role === 'canonical-grid') return 'pure-growth'
  if (role === 'legacy-absolute-envelope') return 'legacy-absolute-envelope'
  return { kind: 'gap-contained' }
}

export function normalizeIntrinsicSharedArchiveConstructedRun(input: {
  readonly sheet: SheetSpec
  readonly role: string
  readonly sourceId: string | undefined
  readonly requestedCandidateEvaluations: number | undefined
  readonly constructed: IntrinsicStrictConstructResult
}): IntrinsicSharedArchiveRun {
  const consumedCandidateEvaluations = input.constructed.candidateEvaluationCount ?? 0
  if (input.constructed.truncationReason === 'maximum-candidate-evaluations') {
    return {
      role: input.role,
      sourceId: input.sourceId,
      status: 'evaluation-cap',
      requestedCandidateEvaluations: input.requestedCandidateEvaluations,
      consumedCandidateEvaluations,
      reason: input.constructed.truncationReason,
      endpoint: undefined,
      runtimeMs: input.constructed.runtimeMs
    }
  }
  const endpoint = makeIntrinsicSharedArchiveEndpoint({
    sheet: input.sheet,
    role: input.role,
    sourceId: input.sourceId,
    state: input.constructed.state,
    runtimeMs: input.constructed.runtimeMs
  })
  if (endpoint === undefined) {
    return {
      role: input.role,
      sourceId: input.sourceId,
      status: 'incomplete',
      requestedCandidateEvaluations: input.requestedCandidateEvaluations,
      consumedCandidateEvaluations,
      reason: 'construction did not produce one complete canonical-exact endpoint',
      endpoint: undefined,
      runtimeMs: input.constructed.runtimeMs
    }
  }
  return {
    role: input.role,
    sourceId: input.sourceId,
    status: 'completed',
    requestedCandidateEvaluations: input.requestedCandidateEvaluations,
    consumedCandidateEvaluations,
    reason: undefined,
    endpoint,
    runtimeMs: input.constructed.runtimeMs
  }
}

/** Adapts any complete exact layout into the common sheetless archive boundary. */
export function makeIntrinsicSharedArchiveEndpoint(input: {
  readonly sheet: SheetSpec
  readonly role: string
  readonly sourceId: string | undefined
  readonly state: IrregularBeamState
  readonly runtimeMs?: number
}): IntrinsicSharedArchiveEndpoint | undefined {
  if (
    input.state.remainingPreparedPieces.length > 0 ||
    input.state.unplacedPieceIds.length > 0
  ) {
    return undefined
  }
  const measured = measureIntrinsicSheetlessCompletedLayout(input.state, input.runtimeMs ?? 0)
  if (measured === undefined) return undefined
  return {
    role: input.role,
    sourceId: input.sourceId,
    sheetlessCanonicalGeometryIdentity: measured.canonicalGeometryIdentity,
    sheetlessCanonicalGeometryHash: measured.canonicalGeometryHash,
    placedCollisionGeometries: measured.placedCollisionGeometries,
    metrics: measured.metrics,
    certificate: evaluateIntrinsicStrictCertificate(measured.metrics),
    requestedSheetFit: requestedSheetFit(input.sheet, input.state)
  }
}

function normalizePeriodicRun(
  sheet: SheetSpec,
  run: IntrinsicPeriodicContinuationResult,
  requestedCandidateEvaluations: number | undefined
): IntrinsicSharedArchiveRun {
  if (run.constructed !== undefined) {
    return normalizeIntrinsicSharedArchiveConstructedRun({
      sheet,
      role: `periodic-${run.continuation.role}`,
      sourceId: run.continuation.sourceId,
      requestedCandidateEvaluations,
      constructed: run.constructed
    })
  }
  return {
    role: `periodic-${run.continuation.role}`,
    sourceId: run.continuation.sourceId,
    status:
      run.status === 'global-deadline'
        ? 'global-deadline'
        : run.status === 'deadline'
          ? 'deadline'
        : run.status === 'evaluation-cap'
          ? 'evaluation-cap'
          : 'invalid',
    requestedCandidateEvaluations,
    consumedCandidateEvaluations: undefined,
    reason: run.reason ?? run.status,
    endpoint: undefined,
    runtimeMs: run.runtimeMs
  }
}

function requestedSheetFit(
  sheet: SheetSpec,
  state: IrregularBeamState
): IntrinsicSharedArchiveSheetFit {
  const fit = (rotationDeg: 0 | 90): {
    readonly rotationDeg: 0 | 90
    readonly fits: boolean
    readonly canonicalGeometryHash: string | undefined
    readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  } => {
    const oriented = state.withQuarterTurnBottomLeft(rotationDeg)
    if (
      oriented === undefined ||
      !assertCanonicalGridLegalLayout(sheet, oriented.placedCollisionGeometries)
    ) {
      return {
        rotationDeg,
        fits: false,
        canonicalGeometryHash: undefined,
        placedCollisionGeometries: []
      }
    }
    const identity = canonicalCollisionLayoutIdentity(oriented.placedCollisionGeometries)
    return {
      rotationDeg,
      fits: identity !== undefined,
      canonicalGeometryHash:
        identity === undefined ? undefined : createHash('sha256').update(identity).digest('hex'),
      placedCollisionGeometries:
        identity === undefined ? [] : oriented.placedCollisionGeometries
    }
  }
  const q0 = fit(0)
  const q90 = fit(90)
  const selected = [q0, q90]
    .filter(
      (
        candidate
      ): candidate is typeof candidate & { readonly canonicalGeometryHash: string } =>
        candidate.fits && candidate.canonicalGeometryHash !== undefined
    )
    .toSorted(
      (first, second) =>
        first.canonicalGeometryHash.localeCompare(second.canonicalGeometryHash) ||
        first.rotationDeg - second.rotationDeg
    )[0]
  return {
    q0: { fits: q0.fits, canonicalGeometryHash: q0.canonicalGeometryHash },
    q90: { fits: q90.fits, canonicalGeometryHash: q90.canonicalGeometryHash },
    selectedRotationDeg: selected?.rotationDeg,
    selectedCanonicalGeometryHash: selected?.canonicalGeometryHash,
    selectedPlacedCollisionGeometries: selected?.placedCollisionGeometries ?? []
  }
}
