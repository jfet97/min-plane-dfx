import { Effect } from 'effect'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type { IrregularPreparedPiece } from '@shared/irregular/domain.js'
import {
  enumerateIntrinsicPeriodicCells,
  expandIntrinsicPeriodicCell,
  rankIntrinsicPeriodicSeeds,
  type IntrinsicPeriodicCatalog,
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

export interface IntrinsicPeriodicFamilyPortfolioResult {
  readonly catalog: IntrinsicPeriodicCatalog
  readonly continuations: ReadonlyArray<IntrinsicPeriodicContinuation>
  readonly continuationOmissions: ReadonlyArray<IntrinsicPeriodicContinuationOmission>
  readonly continuationCoverageComplete: boolean
  readonly runs: ReadonlyArray<IntrinsicPeriodicContinuationResult>
  readonly archive: ReadonlyArray<IntrinsicStrictCompletedMetrics>
  readonly winner: IntrinsicPeriodicContinuationResult | undefined
  readonly runtimeMs: number
}

export interface IntrinsicPeriodicFamilyPortfolioOptions {
  readonly maximumCatalogRuntimeMs?: number
  readonly maximumContinuationRuntimeMs?: number
  readonly maximumContinuationCount?: number
  readonly maximumTotalRuntimeMs?: number
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
    const maximumContinuationRuntimeMs = options.maximumContinuationRuntimeMs ?? 25_000
    const maximumContinuationCount = options.maximumContinuationCount ?? 8
    const maximumTotalRuntimeMs = options.maximumTotalRuntimeMs ?? 240_000
    const catalog = yield* enumerateIntrinsicPeriodicCells(pieces, {
      maximumRuntimeMs: maximumCatalogRuntimeMs,
      maximumFamilyCount: 8,
      maximumTransformsPerFamily: 16,
      maximumPairsPerFamily: 120,
      maximumCellsPerFamilyRole: 16
    })
    const selected = yield* selectIntrinsicPeriodicContinuations(
      catalog,
      pieces,
      maximumContinuationCount
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
  maximumContinuationCount: number
): Effect.Effect<
  {
    readonly continuations: ReadonlyArray<IntrinsicPeriodicContinuation>
    readonly omissions: ReadonlyArray<IntrinsicPeriodicContinuationOmission>
    readonly coverageComplete: boolean
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
    for (const family of catalog.families) {
      const members = familyMembers.get(family.familyKey)
      if (members === undefined) continue
      const continuations: IntrinsicPeriodicContinuation[] = []
      for (const cell of family.cells) {
        const crops = yield* expandIntrinsicPeriodicCell(cell, members, 4)
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
          continuations.push({
            sourceId,
            role: cell.role,
            familyKey: family.familyKey,
            cellKey: cell.canonicalKey,
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
    for (const continuation of all.slice(maximumContinuationCount)) {
      omissions.push({ sourceId: continuation.sourceId, reason: 'continuation-cap' })
    }
    return {
      continuations: selected,
      omissions,
      coverageComplete: all.length <= maximumContinuationCount
    }
  })
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
