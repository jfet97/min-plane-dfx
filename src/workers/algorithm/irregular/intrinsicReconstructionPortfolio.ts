import { Data, Effect } from 'effect'
import { performance } from 'node:perf_hooks'
import type { PieceId } from '@shared/domain/ids.js'
import type { IrregularPlacedPiece, IrregularPreparedPiece } from '@shared/irregular/domain.js'
import { placedCollisionWorldGridPath } from '../../irregular/canonicalLayoutGeometry.js'
import type { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import type {
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError,
  NfpIfpService
} from '../../irregular/services.js'
import {
  constructIntrinsicStrictState,
  IntrinsicStrictDecoderError,
  measureIntrinsicSheetlessCompletedLayout,
  rankIntrinsicStrictCompletedLayouts,
  type IntrinsicStrictCandidateMode,
  type IntrinsicStrictCompletedMetrics,
  type IntrinsicStrictConstructResult
} from './intrinsicStrictDecoder.js'

export const INTRINSIC_RECONSTRUCTION_ARCHIVE_CAPACITY = 8

export const INTRINSIC_RECONSTRUCTION_ROLES = [
  'canonical-grid',
  'legacy-absolute-envelope',
  'reversed-priority',
  'endpoint-q0-left-to-right',
  'endpoint-q0-right-to-left',
  'endpoint-q90-left-to-right',
  'endpoint-q90-right-to-left',
  'open-pocket-first'
] as const

export type IntrinsicReconstructionRole = (typeof INTRINSIC_RECONSTRUCTION_ROLES)[number]

export interface IntrinsicReconstructionSeed {
  readonly role: 'canonical-grid' | 'legacy-absolute-envelope'
  readonly canonicalGeometryHash: string
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly stepTrace: IntrinsicStrictConstructResult['stepTrace']
  readonly metrics: IntrinsicStrictCompletedMetrics
}

export interface IntrinsicReconstructionRun {
  readonly role: IntrinsicReconstructionRole
  readonly sourceEndpointHash: string | undefined
  readonly candidateMode: IntrinsicStrictCandidateMode
  readonly pieceIds: ReadonlyArray<PieceId>
  readonly status: 'completed' | 'deadline' | 'duplicate-order' | 'incomplete'
  readonly duplicateOf: IntrinsicReconstructionRole | undefined
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly stepTrace: IntrinsicStrictConstructResult['stepTrace']
  readonly gapFillEvidence: IntrinsicStrictConstructResult['gapFillEvidence']
  readonly metrics: IntrinsicStrictCompletedMetrics | undefined
  readonly runtimeMs: number
}

export interface IntrinsicReconstructionPortfolioResult {
  readonly runs: ReadonlyArray<IntrinsicReconstructionRun>
  readonly archive: ReadonlyArray<
    IntrinsicReconstructionRun & { metrics: IntrinsicStrictCompletedMetrics }
  >
  readonly winner:
    | (IntrinsicReconstructionRun & { metrics: IntrinsicStrictCompletedMetrics })
    | undefined
  readonly runtimeMs: number
}

export class IntrinsicReconstructionPortfolioError extends Data.TaggedError(
  'IntrinsicReconstructionPortfolioError'
)<{
  readonly operation: 'seed' | 'order' | 'archive'
  readonly message: string
}> {}

type PortfolioError =
  | IntrinsicReconstructionPortfolioError
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError

interface DecodeSpec {
  readonly role: Exclude<IntrinsicReconstructionRole, 'canonical-grid' | 'legacy-absolute-envelope'>
  readonly sourceEndpointHash: string | undefined
  readonly candidateMode: IntrinsicStrictCandidateMode
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
}

/**
 * Runs deterministic sheetless reconstruction orders under one exact archive.
 * Sheet dimensions remain a terminal legality concern outside this portfolio.
 */
export function runIntrinsicReconstructionPortfolio(input: {
  readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly baselineSeeds: ReadonlyArray<IntrinsicReconstructionSeed>
  readonly maximumRuntimeMsPerDecode?: number
  readonly maximumTotalRuntimeMs?: number
}): Effect.Effect<
  IntrinsicReconstructionPortfolioResult,
  PortfolioError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const maximumRuntimeMsPerDecode = input.maximumRuntimeMsPerDecode ?? 120_000
    const maximumTotalRuntimeMs = input.maximumTotalRuntimeMs ?? 300_000
    const seedRuns = baselineSeedRuns(input.baselineSeeds, input.allPreparedPieces)
    const endpoint = selectReconstructionEndpoint(input.baselineSeeds)
    if (endpoint === undefined) {
      return yield* Effect.fail(
        new IntrinsicReconstructionPortfolioError({
          operation: 'seed',
          message: 'the reconstruction portfolio requires one complete exact baseline endpoint.'
        })
      )
    }
    const specs = buildIntrinsicReconstructionSpecs(input.allPreparedPieces, endpoint)
    const runs: IntrinsicReconstructionRun[] = [...seedRuns]
    const orderOwners = new Map<string, IntrinsicReconstructionRole>()
    for (const run of seedRuns) {
      orderOwners.set(
        `${candidateModeKey(run.candidateMode)}:${pieceOrderKey(run.pieceIds)}`,
        run.role
      )
    }

    for (const spec of specs) {
      const orderKey = pieceOrderKey(spec.pieces.map(preparedPieceId))
      const duplicateOf = orderOwners.get(`${candidateModeKey(spec.candidateMode)}:${orderKey}`)
      if (duplicateOf !== undefined) {
        runs.push({
          role: spec.role,
          sourceEndpointHash: spec.sourceEndpointHash,
          candidateMode: spec.candidateMode,
          pieceIds: spec.pieces.map(preparedPieceId),
          status: 'duplicate-order',
          duplicateOf,
          placedCollisionGeometries: [],
          stepTrace: [],
          gapFillEvidence: [],
          metrics: undefined,
          runtimeMs: 0
        })
        continue
      }
      orderOwners.set(`${candidateModeKey(spec.candidateMode)}:${orderKey}`, spec.role)
      const remainingTotalMs = maximumTotalRuntimeMs - (performance.now() - startedAt)
      if (remainingTotalMs <= 0) {
        runs.push(deadlineRun(spec))
        continue
      }
      const decodeStartedAt = performance.now()
      const outcome = yield* constructIntrinsicStrictState({
        allPreparedPieces: spec.pieces,
        remainingPreparedPieces: spec.pieces,
        frozenPlaced: [],
        candidateMode: spec.candidateMode,
        maximumRuntimeMs: Math.min(maximumRuntimeMsPerDecode, remainingTotalMs)
      }).pipe(
        Effect.map((constructed) => ({ status: 'completed' as const, constructed })),
        Effect.catchTag('IrregularNfpIfpControlAbortError', () =>
          Effect.succeed({ status: 'deadline' as const, constructed: undefined })
        )
      )
      if (outcome.constructed === undefined) {
        runs.push({ ...deadlineRun(spec), runtimeMs: performance.now() - decodeStartedAt })
        continue
      }
      const measured = measureIntrinsicSheetlessCompletedLayout(
        outcome.constructed.state,
        outcome.constructed.runtimeMs
      )
      runs.push({
        role: spec.role,
        sourceEndpointHash: spec.sourceEndpointHash,
        candidateMode: spec.candidateMode,
        pieceIds: spec.pieces.map(preparedPieceId),
        status: measured === undefined ? 'incomplete' : 'completed',
        duplicateOf: undefined,
        placedCollisionGeometries: measured?.placedCollisionGeometries ?? [],
        stepTrace: outcome.constructed.stepTrace,
        gapFillEvidence: outcome.constructed.gapFillEvidence,
        metrics: measured?.metrics,
        runtimeMs: performance.now() - decodeStartedAt
      })
    }

    const archive = retainIntrinsicReconstructionArchive(runs)
    return {
      runs,
      archive,
      winner: archive[0],
      runtimeMs: performance.now() - startedAt
    }
  })
}

/** Builds the six bounded reconstructions justified by corrected F0. */
export function buildIntrinsicReconstructionSpecs(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  endpoint: IntrinsicReconstructionSeed
): ReadonlyArray<DecodeSpec> {
  const endpointOrders = buildCanonicalEndpointOrders(pieces, endpoint.placedCollisionGeometries)
  return [
    {
      role: 'reversed-priority',
      sourceEndpointHash: undefined,
      candidateMode: 'pure-growth',
      pieces: [...pieces].reverse()
    },
    ...endpointOrders.map(({ role, pieces: ordered }) => ({
      role,
      sourceEndpointHash: endpoint.canonicalGeometryHash,
      candidateMode: 'pure-growth' as const,
      pieces: ordered
    })),
    {
      role: 'open-pocket-first',
      sourceEndpointHash: undefined,
      candidateMode: { kind: 'gap-contained' } as const,
      pieces
    }
  ]
}

/** Derives deterministic q0/q90 traversal orders from one exact endpoint. */
export function buildCanonicalEndpointOrders(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  placed: ReadonlyArray<IrregularPlacedPiece>
): ReadonlyArray<{
  readonly role:
    | 'endpoint-q0-left-to-right'
    | 'endpoint-q0-right-to-left'
    | 'endpoint-q90-left-to-right'
    | 'endpoint-q90-right-to-left'
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
}> {
  const positions = new Map<PieceId, { readonly doubledX: number; readonly doubledY: number }>()
  for (const placement of placed) {
    const path = placedCollisionWorldGridPath(placement)
    const first = path?.[0]
    if (path === undefined || first === undefined) continue
    let minX = first.x
    let minY = first.y
    let maxX = first.x
    let maxY = first.y
    for (const point of path.slice(1)) {
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x)
      maxY = Math.max(maxY, point.y)
    }
    positions.set(placedPieceId(placement), {
      doubledX: minX + maxX,
      doubledY: minY + maxY
    })
  }
  const order = (
    role: 'q0-ltr' | 'q0-rtl' | 'q90-ltr' | 'q90-rtl'
  ): ReadonlyArray<IrregularPreparedPiece> =>
    [...pieces].sort((first, second) => {
      const firstPosition = positions.get(preparedPieceId(first))
      const secondPosition = positions.get(preparedPieceId(second))
      if (firstPosition === undefined || secondPosition === undefined) {
        return preparedPieceId(first).localeCompare(preparedPieceId(second))
      }
      const firstPrimary =
        role === 'q0-ltr'
          ? firstPosition.doubledX
          : role === 'q0-rtl'
            ? -firstPosition.doubledX
            : role === 'q90-ltr'
              ? -firstPosition.doubledY
              : firstPosition.doubledY
      const secondPrimary =
        role === 'q0-ltr'
          ? secondPosition.doubledX
          : role === 'q0-rtl'
            ? -secondPosition.doubledX
            : role === 'q90-ltr'
              ? -secondPosition.doubledY
              : secondPosition.doubledY
      return (
        firstPrimary - secondPrimary ||
        firstPosition.doubledY - secondPosition.doubledY ||
        firstPosition.doubledX - secondPosition.doubledX ||
        preparedPieceId(first).localeCompare(preparedPieceId(second))
      )
    })
  return [
    { role: 'endpoint-q0-left-to-right', pieces: order('q0-ltr') },
    { role: 'endpoint-q0-right-to-left', pieces: order('q0-rtl') },
    { role: 'endpoint-q90-left-to-right', pieces: order('q90-ltr') },
    { role: 'endpoint-q90-right-to-left', pieces: order('q90-rtl') }
  ]
}

/** Keeps at most eight exact canonical identities under the shared topology order. */
export function retainIntrinsicReconstructionArchive(
  runs: ReadonlyArray<IntrinsicReconstructionRun>,
  capacity = INTRINSIC_RECONSTRUCTION_ARCHIVE_CAPACITY
): ReadonlyArray<IntrinsicReconstructionRun & { metrics: IntrinsicStrictCompletedMetrics }> {
  const complete = runs.filter(
    (run): run is IntrinsicReconstructionRun & { metrics: IntrinsicStrictCompletedMetrics } =>
      run.status === 'completed' && run.metrics !== undefined
  )
  const unique = new Map<
    string,
    IntrinsicReconstructionRun & { metrics: IntrinsicStrictCompletedMetrics }
  >()
  for (const run of complete) {
    if (!unique.has(run.metrics.canonicalGeometryHash)) {
      unique.set(run.metrics.canonicalGeometryHash, run)
    }
  }
  const rankedMetrics = rankIntrinsicStrictCompletedLayouts(
    [...unique.values()].map(({ metrics }) => metrics)
  )
  return rankedMetrics
    .flatMap((metrics) => {
      const run = unique.get(metrics.canonicalGeometryHash)
      return run === undefined ? [] : [run]
    })
    .slice(0, Math.max(0, capacity))
}

function baselineSeedRuns(
  seeds: ReadonlyArray<IntrinsicReconstructionSeed>,
  pieces: ReadonlyArray<IrregularPreparedPiece>
): ReadonlyArray<IntrinsicReconstructionRun> {
  const pieceIds = pieces.map(preparedPieceId)
  return seeds.map((seed) => ({
    role: seed.role,
    sourceEndpointHash: undefined,
    candidateMode:
      seed.role === 'canonical-grid'
        ? ('pure-growth' as const)
        : ('legacy-absolute-envelope' as const),
    pieceIds,
    status: 'completed' as const,
    duplicateOf: undefined,
    placedCollisionGeometries: seed.placedCollisionGeometries,
    stepTrace: seed.stepTrace,
    gapFillEvidence: [],
    metrics: seed.metrics,
    runtimeMs: seed.metrics.runtimeMs
  }))
}

function selectReconstructionEndpoint(
  seeds: ReadonlyArray<IntrinsicReconstructionSeed>
): IntrinsicReconstructionSeed | undefined {
  const ranked = rankIntrinsicStrictCompletedLayouts(seeds.map(({ metrics }) => metrics))
  const winningHash = ranked[0]?.canonicalGeometryHash
  return seeds.find(({ canonicalGeometryHash }) => canonicalGeometryHash === winningHash)
}

function deadlineRun(spec: DecodeSpec): IntrinsicReconstructionRun {
  return {
    role: spec.role,
    sourceEndpointHash: spec.sourceEndpointHash,
    candidateMode: spec.candidateMode,
    pieceIds: spec.pieces.map(preparedPieceId),
    status: 'deadline',
    duplicateOf: undefined,
    placedCollisionGeometries: [],
    stepTrace: [],
    gapFillEvidence: [],
    metrics: undefined,
    runtimeMs: 0
  }
}

function candidateModeKey(mode: IntrinsicStrictCandidateMode): string {
  return typeof mode === 'string' ? mode : mode.kind
}

function pieceOrderKey(pieceIds: ReadonlyArray<PieceId>): string {
  return pieceIds.join('|')
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function placedPieceId(piece: IrregularPlacedPiece): PieceId {
  return piece.placement.pieceId ?? piece.placement.sourcePieceId
}
