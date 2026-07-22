import { Effect } from 'effect'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type { IrregularPlacedPiece, IrregularPreparedPiece } from '@shared/irregular/domain.js'
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
  rankIntrinsicStrictCompletedLayouts,
  type IntrinsicStrictCompletedMetrics,
  type IntrinsicStrictConstructResult,
  type IntrinsicStrictDecodeResult,
  type IntrinsicStrictDecoderError
} from './intrinsicStrictDecoder.js'
import {
  type IrregularGeometryInputError,
  type IrregularNestingNotImplementedError,
  type IrregularNfpIfpControlAbortError,
  type NfpIfpService
} from '../../irregular/services.js'
import type { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import { groupIntrinsicCollisionFamilies } from './intrinsicStrictFamilyPortfolio.js'

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
    readonly bookkeepingMs: number
    readonly coverageComplete: boolean
    readonly totalMs: number
  }
  readonly executionOrderingMs: number
  readonly constructionMs: number
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
    const maximumContinuationCandidateEvaluations =
      options.maximumContinuationCandidateEvaluations
    const capturePhaseTimings = maximumContinuationCandidateEvaluations !== undefined
    const maximumContinuationCount = options.maximumContinuationCount ?? 8
    const maximumTotalRuntimeMs = options.maximumTotalRuntimeMs ?? 240_000
    const catalogStartedAt = capturePhaseTimings ? performance.now() : 0
    const catalog = yield* enumerateIntrinsicPeriodicCells(pieces, {
      maximumRuntimeMs: maximumCatalogRuntimeMs,
      maximumFamilyCount: 8,
      maximumTransformsPerFamily: 16,
      maximumPairsPerFamily: 120,
      maximumCellsPerFamilyRole,
      captureSourceSurvivalAudit: options.captureSourceSurvivalAudit ?? false
    })
    const catalogMs = capturePhaseTimings ? performance.now() - catalogStartedAt : 0
    const selected = yield* selectIntrinsicPeriodicContinuations(
      catalog,
      pieces,
      maximumContinuationCount,
      maximumCropsPerCell,
      options.basisSourceKey,
      options.captureSourceSurvivalAudit ?? false,
      (options.captureSourceSurvivalAudit ?? false) &&
        (options.admitSourceAuditWitnesses ?? false),
      capturePhaseTimings
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
    let finalizationMs = 0
    for (const continuation of continuations) {
      const remainingMs = maximumTotalRuntimeMs - (performance.now() - startedAt)
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
          ...(maximumContinuationCandidateEvaluations === undefined
            ? {}
            : { maximumCandidateEvaluationCount: maximumContinuationCandidateEvaluations })
        }),
        {
          onFailure: (error) => Effect.succeed({ kind: 'failure' as const, error }),
          onSuccess: (value) => Effect.succeed({ kind: 'success' as const, value })
        }
      )
      const runtimeMs = performance.now() - startedContinuationAt
      if (capturePhaseTimings) constructionMs += runtimeMs
      if (constructed.kind === 'failure') {
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
    const phaseTimings = capturePhaseTimings && selected.phaseTimings !== undefined
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
          return {
            catalogMs,
            selectionMs,
            selection: selected.phaseTimings,
            executionOrderingMs,
            constructionMs,
            finalizationMs,
            archiveRankingMs,
            bookkeepingMs,
            coverageComplete:
              phaseResidualCoverageComplete(totalMs, bookkeepingMs) &&
              selected.phaseTimings.coverageComplete,
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
      runs,
      archive,
      winner,
      ...(phaseTimings === undefined ? {} : { phaseTimings }),
      runtimeMs: phaseTimings?.totalMs ?? performance.now() - startedAt
    }
  })
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
  capturePhaseTimings = false
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
  IrregularGeometryInputError
> {
  return Effect.gen(function* () {
    const selectionStartedAt = capturePhaseTimings ? performance.now() : 0
    let sourceAuditCropEnumerationMs = 0
    let retainedCropEnumerationMs = 0
    let cropFrontSelectionMs = 0
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
      const members = familyMembers.get(family.familyKey)
      if (members === undefined) continue
      const continuations: IntrinsicPeriodicContinuation[] = []
      const directValidCropsByCell = new Map<string, ReadonlyArray<IntrinsicPeriodicSeed>>()
      if (captureSourceSurvivalAudit) {
        for (const cell of family.sourceAuditCells ?? family.cells) {
          if (basisSourceKey !== undefined && cell.basisProvenance?.sourceKey !== basisSourceKey) continue
          const audit = sourceAudit(cell)
          const enumerationStartedAt = capturePhaseTimings ? performance.now() : 0
          const directValidCrops = yield* enumerateIntrinsicPeriodicCellCrops(cell, members)
          if (capturePhaseTimings) {
            sourceAuditCropEnumerationMs += performance.now() - enumerationStartedAt
          }
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
        if (basisSourceKey !== undefined && cell.basisProvenance?.sourceKey !== basisSourceKey) continue
        const audit = sourceAudit(cell)
        if (audit !== undefined) audit.retainedCellCount += 1
        let directValidCrops = directValidCropsByCell.get(periodicSourceCellKey(cell))
        if (directValidCrops === undefined) {
          const enumerationStartedAt = capturePhaseTimings ? performance.now() : 0
          directValidCrops = yield* enumerateIntrinsicPeriodicCellCrops(cell, members)
          if (capturePhaseTimings) {
            retainedCropEnumerationMs += performance.now() - enumerationStartedAt
          }
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
    const sourceCropSurvivalResult = [...sourceCropSurvival.values()].toSorted(
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
                basisProvenance: source.basisProvenance,
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
      sourceAuditNonDominatedCropCount: rawAuditFront.length,
      ...(phaseTimings === undefined ? {} : { phaseTimings })
    }
  })
}

function periodicSourceCellKey(cell: IntrinsicPeriodicCatalog['cells'][number]): string {
  return `${cell.role}:${cell.basisProvenance?.sourceKey ?? 'unprovenanced'}:${cell.canonicalKey}`
}

function rankContinuations(
  continuations: ReadonlyArray<IntrinsicPeriodicContinuation>
): ReadonlyArray<IntrinsicPeriodicContinuation> {
  const ranks = new Map(rankIntrinsicPeriodicSeeds(continuations.map(({ seed }) => seed)).map((seed, index) => [seed.canonicalKey, index]))
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
  const remainingOrder = remainingAfterSeed(pieces, seed)
    .map((piece) => piece.pieceId ?? piece.source.id)
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
  const frozen = new Set(seed.placements.map(({ placement }) => placement.pieceId ?? placement.sourcePieceId))
  return pieces.filter((piece) => !frozen.has(piece.pieceId ?? piece.source.id))
}
