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
  type IntrinsicStrictDecoderError
} from './intrinsicStrictDecoder.js'

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

export interface IntrinsicSharedArchivePortfolioOptions {
  readonly directCandidateEvaluationCaps?: Partial<
    Readonly<Record<IntrinsicSharedArchiveDirectRole, number>>
  >
  readonly maximumDirectRuntimeMs?: number
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

type SharedArchiveError =
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError

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
        : { maximumDirectRuntimeMs: options.maximumDirectRuntimeMs })
    })

    const periodicPortfolio = yield* runIntrinsicPeriodicFamilyPortfolio(
      sheet,
      pieces,
      {
        ...options.periodic,
        maximumContinuationCandidateEvaluations:
          INTRINSIC_SHARED_ARCHIVE_PERIODIC_EVALUATION_CAP,
        maximumContinuationCount: INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT,
        captureSourceSurvivalAudit: includeSourceAuditWitnesses,
        admitSourceAuditWitnesses: includeSourceAuditWitnesses
      }
    )
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
    'directCandidateEvaluationCaps' | 'maximumDirectRuntimeMs'
  > = {}
): Effect.Effect<
  ReadonlyArray<IntrinsicSharedArchiveRun>,
  never,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const maximumDirectRuntimeMs = options.maximumDirectRuntimeMs ?? 600_000
    const runs: IntrinsicSharedArchiveRun[] = []
    for (const role of INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES) {
      const startedAt = performance.now()
      const requestedCandidateEvaluations = options.directCandidateEvaluationCaps?.[role]
      const outcome = yield* Effect.matchEffect(
        constructIntrinsicStrictState({
          allPreparedPieces: pieces,
          remainingPreparedPieces: pieces,
          frozenPlaced: [],
          candidateMode: directCandidateMode(role),
          maximumRuntimeMs: maximumDirectRuntimeMs,
          captureCandidateEvaluationCount: true,
          ...(requestedCandidateEvaluations === undefined
            ? {}
            : { maximumCandidateEvaluationCount: requestedCandidateEvaluations })
        }),
        {
          onFailure: (error) => Effect.succeed({ kind: 'failure' as const, error }),
          onSuccess: (constructed) =>
            Effect.succeed({ kind: 'success' as const, constructed })
        }
      )
      if (outcome.kind === 'failure') {
        runs.push({
          role,
          sourceId: undefined,
          status:
            outcome.error._tag === 'IrregularNfpIfpControlAbortError' ? 'deadline' : 'invalid',
          requestedCandidateEvaluations,
          consumedCandidateEvaluations: undefined,
          reason: outcome.error._tag,
          endpoint: undefined,
          runtimeMs: Math.max(0, performance.now() - startedAt)
        })
        continue
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
  const unique = new Map<string, IntrinsicSharedArchiveEndpoint>()
  for (const endpoint of endpoints) {
    if (!unique.has(endpoint.sheetlessCanonicalGeometryHash)) {
      unique.set(endpoint.sheetlessCanonicalGeometryHash, endpoint)
    }
  }
  return rankIntrinsicStrictCompletedLayouts([...unique.values()].map(({ metrics }) => metrics))
    .flatMap((metrics) => {
      const endpoint = unique.get(metrics.canonicalGeometryHash)
      return endpoint === undefined ? [] : [endpoint]
    })
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

/** Requires uncensored catalog selection and deterministic settlement of all eight sources. */
export function intrinsicSharedPeriodicSelectionValid(
  input: {
    readonly catalogRuntimeCoverageComplete: boolean
    readonly selectedContinuationCount: number
    readonly runCount: number
    readonly budgetSettlementComplete: boolean
  }
): boolean {
  return (
    input.catalogRuntimeCoverageComplete &&
    input.selectedContinuationCount === INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT &&
    input.runCount === INTRINSIC_SHARED_ARCHIVE_PERIODIC_CONTINUATION_COUNT &&
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
  const measured = measureIntrinsicSheetlessCompletedLayout(
    input.constructed.state,
    input.constructed.runtimeMs
  )
  if (measured === undefined) {
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
    endpoint: {
      role: input.role,
      sourceId: input.sourceId,
      sheetlessCanonicalGeometryIdentity: measured.canonicalGeometryIdentity,
      sheetlessCanonicalGeometryHash: measured.canonicalGeometryHash,
      placedCollisionGeometries: measured.placedCollisionGeometries,
      metrics: measured.metrics,
      certificate: evaluateIntrinsicStrictCertificate(measured.metrics),
      requestedSheetFit: requestedSheetFit(input.sheet, input.constructed)
    },
    runtimeMs: input.constructed.runtimeMs
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
  constructed: IntrinsicStrictConstructResult
): IntrinsicSharedArchiveSheetFit {
  const fit = (rotationDeg: 0 | 90): {
    readonly rotationDeg: 0 | 90
    readonly fits: boolean
    readonly canonicalGeometryHash: string | undefined
    readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  } => {
    const oriented = constructed.state.withQuarterTurnBottomLeft(rotationDeg)
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
