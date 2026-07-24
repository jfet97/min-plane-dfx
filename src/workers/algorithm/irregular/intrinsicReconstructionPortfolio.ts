import { Data, Effect } from 'effect'
import { performance } from 'node:perf_hooks'
import type { PieceId } from '@shared/domain/ids.js'
import type { IrregularPlacedPiece, IrregularPreparedPiece } from '@shared/irregular/domain.js'
import { placedCollisionWorldGridPath } from '../../irregular/canonicalLayoutGeometry.js'
import { toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import type { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import type {
  IrregularGeometryInputError,
  IrregularNfpIfpControl,
  IrregularNfpIfpControlAbortError,
  IrregularNestingNotImplementedError,
  NfpIfpService
} from '../../irregular/services.js'
import {
  constructIntrinsicStrictState,
  IntrinsicStrictDecoderError,
  measureIntrinsicSheetlessCompletedLayout,
  rankIntrinsicStrictCompletedLayouts,
  selectIntrinsicStrictCompletedParetoFront,
  type IntrinsicStrictCandidateMode,
  type IntrinsicStrictCompletedMetrics,
  type IntrinsicStrictConstructResult
} from './intrinsicStrictDecoder.js'

export const INTRINSIC_RECONSTRUCTION_ARCHIVE_CAPACITY = 8

export const INTRINSIC_RECONSTRUCTION_ROLES = [
  'canonical-grid',
  'legacy-absolute-envelope',
  'settled-protected',
  'reversed-priority',
  'endpoint-q0-left-to-right',
  'endpoint-q0-right-to-left',
  'endpoint-q90-left-to-right',
  'endpoint-q90-right-to-left',
  'open-pocket-first',
  'reversed-priority-open-pocket-first',
  'endpoint-q0-left-to-right-open-pocket-first',
  'endpoint-q0-right-to-left-open-pocket-first',
  'endpoint-q90-left-to-right-open-pocket-first',
  'endpoint-q90-right-to-left-open-pocket-first'
] as const

export type IntrinsicReconstructionRole = (typeof INTRINSIC_RECONSTRUCTION_ROLES)[number]

export type IntrinsicReconstructionRoleFamily =
  | 'all'
  | 'pure-growth'
  | 'gap-contained'
  | 'endpoint-q90-right-to-left'

export interface IntrinsicReconstructionSeed {
  readonly role:
    | 'canonical-grid'
    | 'legacy-absolute-envelope'
    | 'settled-protected'
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
  readonly effectiveOrderKey: string
  readonly status:
    | 'completed'
    | 'deadline'
    | 'evaluation-cap'
    | 'duplicate-order'
    | 'incomplete'
  readonly duplicateOf: IntrinsicReconstructionRole | undefined
  readonly requestedCandidateEvaluations: number | undefined
  readonly consumedCandidateEvaluations: number | undefined
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
  readonly consumedCandidateEvaluations: number
  readonly candidateEvaluationAccountingComplete: boolean
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
  | IrregularNfpIfpControlAbortError

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
  readonly roleFamily?: IntrinsicReconstructionRoleFamily
  readonly maximumCandidateEvaluationsPerDecode?: number
  readonly maximumTotalCandidateEvaluations?: number
  readonly control?: IrregularNfpIfpControl
}): Effect.Effect<
  IntrinsicReconstructionPortfolioResult,
  PortfolioError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const maximumRuntimeMsPerDecode = input.maximumRuntimeMsPerDecode ?? 120_000
    const maximumTotalRuntimeMs = input.maximumTotalRuntimeMs ?? 300_000
    const roleFamily = input.roleFamily ?? 'all'
    const maximumCandidateEvaluationsPerDecode =
      input.maximumCandidateEvaluationsPerDecode
    const maximumTotalCandidateEvaluations =
      input.maximumTotalCandidateEvaluations
    let consumedCandidateEvaluations = 0
    let candidateEvaluationAccountingComplete = true
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
    const specs = buildIntrinsicReconstructionSpecs(
      input.allPreparedPieces,
      endpoint
    ).filter((spec) => intrinsicReconstructionSpecMatchesFamily(spec, roleFamily))
    const runs: IntrinsicReconstructionRun[] = [...seedRuns]
    const orderOwners = new Map<string, IntrinsicReconstructionRole>()
    for (const run of seedRuns) {
      orderOwners.set(
        `${candidateModeKey(run.candidateMode)}:${intrinsicReconstructionEffectiveOrderKey(input.allPreparedPieces)}`,
        run.role
      )
    }

    for (const spec of specs) {
      const orderKey = intrinsicReconstructionEffectiveOrderKey(spec.pieces)
      const duplicateOf = orderOwners.get(`${candidateModeKey(spec.candidateMode)}:${orderKey}`)
      if (duplicateOf !== undefined) {
        runs.push({
          role: spec.role,
          sourceEndpointHash: spec.sourceEndpointHash,
          candidateMode: spec.candidateMode,
          pieceIds: spec.pieces.map(preparedPieceId),
          effectiveOrderKey: orderKey,
          status: 'duplicate-order',
          duplicateOf,
          requestedCandidateEvaluations: 0,
          consumedCandidateEvaluations: 0,
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
        candidateEvaluationAccountingComplete = false
        continue
      }
      const remainingCandidateEvaluations =
        maximumTotalCandidateEvaluations === undefined
          ? undefined
          : maximumTotalCandidateEvaluations - consumedCandidateEvaluations
      if (
        remainingCandidateEvaluations !== undefined &&
        remainingCandidateEvaluations <= 0
      ) {
        runs.push(evaluationCapRun(spec))
        continue
      }
      const requestedCandidateEvaluations =
        maximumCandidateEvaluationsPerDecode === undefined
          ? remainingCandidateEvaluations
          : remainingCandidateEvaluations === undefined
            ? maximumCandidateEvaluationsPerDecode
            : Math.min(
                maximumCandidateEvaluationsPerDecode,
                remainingCandidateEvaluations
              )
      const decodeStartedAt = performance.now()
      const outcome = yield* constructIntrinsicStrictState({
        allPreparedPieces: spec.pieces,
        remainingPreparedPieces: spec.pieces,
        frozenPlaced: [],
        candidateMode: spec.candidateMode,
        maximumRuntimeMs: Math.min(maximumRuntimeMsPerDecode, remainingTotalMs),
        captureCandidateEvaluationCount: true,
        ...(input.control === undefined ? {} : { control: input.control }),
        ...(requestedCandidateEvaluations === undefined
          ? {}
          : { maximumCandidateEvaluationCount: requestedCandidateEvaluations })
      }).pipe(
        Effect.map((constructed) => ({ status: 'completed' as const, constructed })),
        Effect.catchTag('IrregularNfpIfpControlAbortError', (error) =>
          error.reason === 'cancelled'
            ? Effect.fail(error)
            : Effect.succeed({
                status: 'deadline' as const,
                constructed: undefined
              })
        )
      )
      if (outcome.constructed === undefined) {
        candidateEvaluationAccountingComplete = false
        runs.push({
          ...deadlineRun(spec, requestedCandidateEvaluations),
          runtimeMs: performance.now() - decodeStartedAt
        })
        continue
      }
      const consumedByDecode = outcome.constructed.candidateEvaluationCount ?? 0
      consumedCandidateEvaluations += consumedByDecode
      if (
        outcome.constructed.truncationReason ===
        'maximum-candidate-evaluations'
      ) {
        runs.push({
          ...evaluationCapRun(spec),
          requestedCandidateEvaluations,
          consumedCandidateEvaluations: consumedByDecode,
          runtimeMs: performance.now() - decodeStartedAt
        })
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
        effectiveOrderKey: orderKey,
        status: measured === undefined ? 'incomplete' : 'completed',
        duplicateOf: undefined,
        requestedCandidateEvaluations,
        consumedCandidateEvaluations: consumedByDecode,
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
      runtimeMs: performance.now() - startedAt,
      consumedCandidateEvaluations,
      candidateEvaluationAccountingComplete
    }
  })
}

/** Builds bounded pure-growth and gap-contained reconstructions from generic geometry orders. */
export function buildIntrinsicReconstructionSpecs(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  endpoint: IntrinsicReconstructionSeed
): ReadonlyArray<DecodeSpec> {
  const endpointOrders = buildCanonicalEndpointOrders(pieces, endpoint.placedCollisionGeometries)
  const gapContainedEndpointOrders = endpointOrders.map(({ role, pieces: ordered }) => ({
    role: `${role}-open-pocket-first` as const,
    sourceEndpointHash: endpoint.canonicalGeometryHash,
    candidateMode: { kind: 'gap-contained' } as const,
    pieces: ordered
  }))
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
    },
    {
      role: 'reversed-priority-open-pocket-first',
      sourceEndpointHash: undefined,
      candidateMode: { kind: 'gap-contained' } as const,
      pieces: [...pieces].reverse()
    },
    ...gapContainedEndpointOrders
  ]
}

/** Selects one deterministic reconstruction family without changing role order. */
export function intrinsicReconstructionSpecMatchesFamily(
  spec: Pick<DecodeSpec, 'role' | 'candidateMode'>,
  family: IntrinsicReconstructionRoleFamily
): boolean {
  if (family === 'all') return true
  if (family === 'endpoint-q90-right-to-left') {
    return spec.role === family
  }
  const isGapContained = typeof spec.candidateMode === 'object'
  return family === 'gap-contained' ? isGapContained : !isGapContained
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

/** Keeps the baseline seeds plus exact Pareto representatives within the shared capacity. */
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
  const uniqueRuns = [...unique.values()]
  const rankedMetrics = selectIntrinsicStrictCompletedParetoFront(
    uniqueRuns.map(({ metrics }) => metrics)
  )
  const rankedRuns = rankedMetrics
    .flatMap((metrics) => {
      const run = unique.get(metrics.canonicalGeometryHash)
      return run === undefined ? [] : [run]
    })
  const boundedCapacity = Math.max(0, capacity)
  const protectedSeeds = uniqueRuns.filter(
    ({ role }) => role === 'canonical-grid' || role === 'legacy-absolute-envelope'
  )
  const selected: Array<
    IntrinsicReconstructionRun & { metrics: IntrinsicStrictCompletedMetrics }
  > = []
  const append = (run: IntrinsicReconstructionRun & { metrics: IntrinsicStrictCompletedMetrics }) => {
    if (
      selected.length < boundedCapacity &&
      !selected.some(({ metrics }) => metrics.canonicalGeometryHash === run.metrics.canonicalGeometryHash)
    ) {
      selected.push(run)
    }
  }
  const frontierLeader = rankedRuns[0]
  if (frontierLeader !== undefined) append(frontierLeader)
  for (const seed of protectedSeeds) append(seed)
  for (const run of rankedRuns) append(run)
  return selected
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
        : seed.role === 'legacy-absolute-envelope'
          ? ('legacy-absolute-envelope' as const)
          : ('pure-growth' as const),
    pieceIds,
    effectiveOrderKey: intrinsicReconstructionEffectiveOrderKey(pieces),
    status: 'completed' as const,
    duplicateOf: undefined,
    requestedCandidateEvaluations: 0,
    consumedCandidateEvaluations: 0,
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

function deadlineRun(
  spec: DecodeSpec,
  requestedCandidateEvaluations?: number
): IntrinsicReconstructionRun {
  return {
    role: spec.role,
    sourceEndpointHash: spec.sourceEndpointHash,
    candidateMode: spec.candidateMode,
    pieceIds: spec.pieces.map(preparedPieceId),
    effectiveOrderKey: intrinsicReconstructionEffectiveOrderKey(spec.pieces),
    status: 'deadline',
    duplicateOf: undefined,
    requestedCandidateEvaluations,
    consumedCandidateEvaluations: undefined,
    placedCollisionGeometries: [],
    stepTrace: [],
    gapFillEvidence: [],
    metrics: undefined,
    runtimeMs: 0
  }
}

function evaluationCapRun(spec: DecodeSpec): IntrinsicReconstructionRun {
  return {
    ...deadlineRun(spec),
    status: 'evaluation-cap'
  }
}

function candidateModeKey(mode: IntrinsicStrictCandidateMode): string {
  return typeof mode === 'string' ? mode : mode.kind
}

/** Identifies orders by canonical geometry classes so interchangeable ids cannot duplicate work. */
export function intrinsicReconstructionEffectiveOrderKey(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): string {
  return pieces.map(intrinsicPreparedPieceClassKey).join('|')
}

export function intrinsicPreparedPieceClassKey(piece: IrregularPreparedPiece): string {
  const points = piece.collisionGeometry.collisionPolygon.points.map(({ x, y }) => ({
    x: toGridMm(x),
    y: toGridMm(y)
  }))
  if (points.some(({ x, y }) => x === undefined || y === undefined)) {
    return `piece:${preparedPieceId(piece)}`
  }
  const gridPoints = points.map(({ x, y }) => ({ x: x ?? 0, y: y ?? 0 }))
  const minimumX = Math.min(...gridPoints.map(({ x }) => x))
  const minimumY = Math.min(...gridPoints.map(({ y }) => y))
  const normalized = gridPoints.map(({ x, y }) => ({ x: x - minimumX, y: y - minimumY }))
  const referenceX = toGridMm(piece.collisionGeometry.placementReference.x)
  const referenceY = toGridMm(piece.collisionGeometry.placementReference.y)
  if (referenceX === undefined || referenceY === undefined) {
    return `piece:${preparedPieceId(piece)}`
  }
  const transforms = [...piece.transforms]
    .sort(
      (first, second) =>
        first.index - second.index ||
        first.rotationDeg - second.rotationDeg ||
        Number(first.mirrored) - Number(second.mirrored) ||
        first.reason.localeCompare(second.reason)
    )
    .map(
      ({ index, rotationDeg, mirrored, reason }) =>
        `${index}:${rotationDeg}:${Number(mirrored)}:${reason}`
    )
    .join(',')
  return `${canonicalPointRing(normalized)}@${referenceX - minimumX},${referenceY - minimumY}:${Number(piece.allowMirror)}:${transforms}`
}

function canonicalPointRing(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>
): string {
  const variants = [points, [...points].reverse()].flatMap((sequence) =>
    sequence.map((_, offset) =>
      [...sequence.slice(offset), ...sequence.slice(0, offset)]
        .map(({ x, y }) => `${x},${y}`)
        .join(';')
    )
  )
  return variants.toSorted()[0] ?? ''
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function placedPieceId(piece: IrregularPlacedPiece): PieceId {
  return piece.placement.pieceId ?? piece.placement.sourcePieceId
}
