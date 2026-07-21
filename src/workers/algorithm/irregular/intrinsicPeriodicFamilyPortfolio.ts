import { Effect } from 'effect'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type { IrregularPreparedPiece } from '@shared/irregular/domain.js'
import {
  enumerateIntrinsicPeriodicCells,
  enumerateIntrinsicPeriodicCellCrops,
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
  readonly status: IntrinsicStrictDecodeResult['status'] | 'invalid' | 'deadline' | 'global-deadline'
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
  readonly sourceKey: string
  readonly sourceKind: IntrinsicPeriodicBasisProvenance['sourceKind']
  readonly cellKey: string
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
  readonly sourceCropSurvival: ReadonlyArray<IntrinsicPeriodicSourceCropSurvival>
  readonly sourceAuditWitnesses: ReadonlyArray<IntrinsicPeriodicSourceAuditWitness>
  readonly runs: ReadonlyArray<IntrinsicPeriodicContinuationResult>
  readonly archive: ReadonlyArray<IntrinsicStrictCompletedMetrics>
  readonly winner: IntrinsicPeriodicContinuationResult | undefined
  readonly runtimeMs: number
}

export interface IntrinsicPeriodicFamilyPortfolioOptions {
  readonly maximumCatalogRuntimeMs?: number
  readonly maximumCellsPerFamilyRole?: number
  readonly maximumCropsPerCell?: number
  readonly maximumContinuationRuntimeMs?: number
  readonly maximumContinuationCount?: number
  readonly maximumTotalRuntimeMs?: number
  /** Restricts an experiment to one rational NFP-derived shared-basis source. */
  readonly basisSourceKey?: string
  /** Enables a bounded observer over raw source cells without changing continuations. */
  readonly captureSourceSurvivalAudit?: boolean
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
    const maximumContinuationCount = options.maximumContinuationCount ?? 8
    const maximumTotalRuntimeMs = options.maximumTotalRuntimeMs ?? 240_000
    const catalog = yield* enumerateIntrinsicPeriodicCells(pieces, {
      maximumRuntimeMs: maximumCatalogRuntimeMs,
      maximumFamilyCount: 8,
      maximumTransformsPerFamily: 16,
      maximumPairsPerFamily: 120,
      maximumCellsPerFamilyRole,
      captureSourceSurvivalAudit: options.captureSourceSurvivalAudit ?? false
    })
    const selected = yield* selectIntrinsicPeriodicContinuations(
      catalog,
      pieces,
      maximumContinuationCount,
      maximumCropsPerCell,
      options.basisSourceKey,
      options.captureSourceSurvivalAudit ?? false
    )
    const runs: IntrinsicPeriodicContinuationResult[] = []
    for (const continuation of selected.continuations) {
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
          maximumRuntimeMs: Math.min(maximumContinuationRuntimeMs, remainingMs)
        }),
        {
          onFailure: (error) => Effect.succeed({ kind: 'failure' as const, error }),
          onSuccess: (value) => Effect.succeed({ kind: 'success' as const, value })
        }
      )
      const runtimeMs = performance.now() - startedContinuationAt
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
      const result = yield* finalizeIntrinsicStrictState(archiveSheet, constructed.value, runtimeMs)
      runs.push({
        continuation,
        status: result.status,
        result,
        constructed: constructed.value,
        reason: undefined,
        runtimeMs
      })
    }
    const archive = rankIntrinsicStrictCompletedLayouts(
      runs.flatMap((run) => (run.result?.metrics === undefined ? [] : [run.result.metrics]))
    )
    const winningHash = archive[0]?.canonicalGeometryHash
    return {
      catalog,
      continuations: selected.continuations,
      continuationOmissions: selected.omissions,
      continuationCoverageComplete: selected.coverageComplete,
      sourceCropSurvival: selected.sourceCropSurvival,
      sourceAuditWitnesses: selected.sourceAuditWitnesses,
      runs,
      archive,
      winner:
        winningHash === undefined
          ? undefined
          : runs.find((run) => run.result?.metrics?.canonicalGeometryHash === winningHash),
      runtimeMs: performance.now() - startedAt
    }
  })
}

function selectIntrinsicPeriodicContinuations(
  catalog: IntrinsicPeriodicCatalog,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  maximumContinuationCount: number,
  maximumCropsPerCell: number,
  basisSourceKey: string | undefined,
  captureSourceSurvivalAudit: boolean
): Effect.Effect<
  {
    readonly continuations: ReadonlyArray<IntrinsicPeriodicContinuation>
    readonly omissions: ReadonlyArray<IntrinsicPeriodicContinuationOmission>
    readonly coverageComplete: boolean
    readonly sourceCropSurvival: ReadonlyArray<IntrinsicPeriodicSourceCropSurvival>
    readonly sourceAuditWitnesses: ReadonlyArray<IntrinsicPeriodicSourceAuditWitness>
  },
  IrregularGeometryInputError
> {
  return Effect.gen(function* () {
    const familyMembers = new Map(
      groupIntrinsicCollisionFamilies(pieces).map((family) => [family.key, family.members])
    )
    const perFamily: ReadonlyArray<IntrinsicPeriodicContinuation>[] = []
    const seenSeeds = new Set<string>()
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
      { readonly sourceKey: string; readonly sourceKind: IntrinsicPeriodicBasisProvenance['sourceKind']; readonly seed: IntrinsicPeriodicSeed }
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
          const directValidCrops = yield* enumerateIntrinsicPeriodicCellCrops(cell, members)
          if (audit !== undefined) audit.directValidCropCountBeforeFront += directValidCrops.length
          const provenance = cell.basisProvenance
          if (provenance !== undefined) {
            for (const seed of directValidCrops) {
              const current = sourceAuditWitnesses.get(seed.canonicalKey)
              if (current === undefined || provenance.sourceKey < current.sourceKey) {
                sourceAuditWitnesses.set(seed.canonicalKey, {
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
        const directValidCrops =
          directValidCropsByCell.get(periodicSourceCellKey(cell)) ??
          (yield* enumerateIntrinsicPeriodicCellCrops(cell, members))
        const crops = selectIntrinsicPeriodicSeedFront(directValidCrops, maximumCropsPerCell)
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
          if (seenSeeds.has(seed.canonicalKey)) {
            omissions.push({ sourceId, reason: 'duplicate-canonical-seed' })
            continue
          }
          seenSeeds.add(seed.canonicalKey)
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
      perFamily.push(rankContinuations(continuations))
    }
    const reserved = perFamily.flatMap((continuations) => continuations.slice(0, 1))
    const fill = rankContinuations(perFamily.flatMap((continuations) => continuations.slice(1)))
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
    return {
      continuations: selected,
      omissions,
      coverageComplete: all.length <= maximumContinuationCount,
      sourceCropSurvival: [...sourceCropSurvival.values()].toSorted(
        (first, second) =>
          first.role.localeCompare(second.role) || first.sourceKey.localeCompare(second.sourceKey)
      ),
      sourceAuditWitnesses: rankIntrinsicPeriodicSeeds(
        [...sourceAuditWitnesses.values()].map(({ seed }) => seed)
      )
        .slice(0, 16)
        .flatMap((seed) => {
          const source = sourceAuditWitnesses.get(seed.canonicalKey)
          return source === undefined
            ? []
            : [
                {
                  role: seed.role,
                  sourceKey: source.sourceKey,
                  sourceKind: source.sourceKind,
                  cellKey: seed.cellKey,
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

function remainingAfterSeed(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  seed: IntrinsicPeriodicSeed
): ReadonlyArray<IrregularPreparedPiece> {
  const frozen = new Set(seed.placements.map(({ placement }) => placement.pieceId ?? placement.sourcePieceId))
  return pieces.filter((piece) => !frozen.has(piece.pieceId ?? piece.source.id))
}
