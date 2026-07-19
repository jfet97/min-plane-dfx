import { Effect } from 'effect'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPreparedPiece,
  type IrregularTransformCandidate,
  type TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  type IrregularGeometryInputError,
  type IrregularNestingNotImplementedError,
  type NfpIfpService
} from '../../irregular/services.js'
import {
  decodeIntrinsicStrictPriorityOrder,
  rankIntrinsicStrictCompletedLayouts,
  type IntrinsicStrictCompletedMetrics,
  type IntrinsicStrictDecodeResult,
  type IntrinsicStrictDecoderError
} from './intrinsicStrictDecoder.js'

export const INTRINSIC_FAMILY_PORTFOLIO_ORDER_IDS = [
  'baseline',
  'family-round-robin',
  'size-band-family-interleave',
  'large-first-small-fill'
] as const

export type IntrinsicFamilyPortfolioOrderId =
  (typeof INTRINSIC_FAMILY_PORTFOLIO_ORDER_IDS)[number]

export const INTRINSIC_FAMILY_PORTFOLIO_TEMPLATE_IDS = ['coaxial', 'crossed'] as const

export type IntrinsicFamilyPortfolioTemplateId =
  (typeof INTRINSIC_FAMILY_PORTFOLIO_TEMPLATE_IDS)[number]

export interface IntrinsicCollisionFamily {
  readonly key: string
  readonly members: ReadonlyArray<IrregularPreparedPiece>
  readonly firstBaselineIndex: number
  readonly collisionAreaMm2: number
  readonly maximumSideMm: number
  readonly aspectRatio: number
}

export interface IntrinsicFamilyPortfolioChromosome {
  readonly orderId: IntrinsicFamilyPortfolioOrderId
  readonly templateId: IntrinsicFamilyPortfolioTemplateId
  readonly status: 'valid' | 'invalid' | 'duplicate'
  readonly invalidReason: string | undefined
  readonly duplicateOf: string | undefined
  readonly identitySha256: string | undefined
  readonly selectedElongatedFamilyKeys: ReadonlyArray<string>
  readonly pieceIds: ReadonlyArray<PieceId>
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
}

export interface IntrinsicFamilyPortfolioRun {
  readonly chromosome: IntrinsicFamilyPortfolioChromosome
  readonly status:
    | IntrinsicFamilyPortfolioChromosome['status']
    | IntrinsicStrictDecodeResult['status']
    | 'deadline'
    | 'global-deadline'
  readonly result: IntrinsicStrictDecodeResult | undefined
  readonly runtimeMs: number
}

export interface IntrinsicFamilyPortfolioResult {
  readonly chromosomes: ReadonlyArray<IntrinsicFamilyPortfolioChromosome>
  readonly runs: ReadonlyArray<IntrinsicFamilyPortfolioRun>
  readonly archive: ReadonlyArray<IntrinsicStrictCompletedMetrics>
  readonly winner: IntrinsicFamilyPortfolioRun | undefined
  readonly runtimeMs: number
}

type PortfolioError =
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError

interface PreparedChromosome {
  readonly orderId: IntrinsicFamilyPortfolioOrderId
  readonly templateId: IntrinsicFamilyPortfolioTemplateId
  readonly selectedElongatedFamilyKeys: ReadonlyArray<string>
  readonly pieces: ReadonlyArray<IrregularPreparedPiece>
  readonly invalidReason: string | undefined
}

/** Groups prepared copies by both declared interchangeability and exact collision shape. */
export function groupIntrinsicCollisionFamilies(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): ReadonlyArray<IntrinsicCollisionFamily> {
  const groups = new Map<string, { members: IrregularPreparedPiece[]; firstBaselineIndex: number }>()
  pieces.forEach((piece, index) => {
    const key = intrinsicCollisionFamilyKey(piece)
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, { members: [piece], firstBaselineIndex: index })
    } else {
      existing.members.push(piece)
    }
  })
  return [...groups.entries()].map(([key, group]) => {
    const first = group.members[0]
    const bounds = first?.collisionGeometry.collisionPolygon.points
    const measurements = bounds === undefined ? undefined : measureCollisionPolygon(bounds)
    return {
      key,
      members: group.members,
      firstBaselineIndex: group.firstBaselineIndex,
      collisionAreaMm2: measurements?.areaMm2 ?? 0,
      maximumSideMm: measurements?.maximumSideMm ?? 0,
      aspectRatio: measurements?.aspectRatio ?? 1
    }
  })
}

/** Stable collision-family key with source-copy identity intentionally excluded. */
export function intrinsicCollisionFamilyKey(piece: IrregularPreparedPiece): string {
  const interchangeabilityKey = piece.interchangeabilityKey ?? piece.source.id
  return JSON.stringify([
    interchangeabilityKey,
    canonicalCyclicPolygonKey(piece.collisionGeometry.collisionPolygon.points)
  ])
}

/** Applies one of the four preregistered generic orders without consulting a sheet. */
export function orderIntrinsicFamilyPortfolioPieces(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  orderId: IntrinsicFamilyPortfolioOrderId
): ReadonlyArray<IrregularPreparedPiece> {
  switch (orderId) {
    case 'baseline':
      return [...pieces]
    case 'family-round-robin':
      return familyRoundRobin(pieces)
    case 'size-band-family-interleave':
      return sizeBands(pieces).flatMap(familyRoundRobin)
    case 'large-first-small-fill': {
      const areas = pieces.map(collisionAreaMm2)
      const maximumAreaMm2 = Math.max(0, ...areas)
      const thresholdMm2 = maximumAreaMm2 / 8
      return [
        ...pieces.filter((_, index) => (areas[index] ?? 0) >= thresholdMm2),
        ...pieces.filter((_, index) => (areas[index] ?? 0) < thresholdMm2)
      ]
    }
  }
}

/** Consecutive 75% long-side bands used by the family-interleave chromosome. */
export function sizeBands(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): ReadonlyArray<ReadonlyArray<IrregularPreparedPiece>> {
  const bands: IrregularPreparedPiece[][] = []
  let current: IrregularPreparedPiece[] = []
  let bandFirstLongSideMm = 0
  for (const piece of pieces) {
    const longSideMm = collisionMaximumSideMm(piece)
    if (current.length === 0 || longSideMm >= bandFirstLongSideMm * 0.75) {
      if (current.length === 0) bandFirstLongSideMm = longSideMm
      current.push(piece)
      continue
    }
    bands.push(current)
    current = [piece]
    bandFirstLongSideMm = longSideMm
  }
  if (current.length > 0) bands.push(current)
  return bands
}

/** Selects the two largest repeated elongated families without fixture knowledge. */
export function selectRepeatedElongatedFamilies(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): ReadonlyArray<IntrinsicCollisionFamily> {
  return groupIntrinsicCollisionFamilies(pieces)
    .filter((family) => family.members.length >= 2 && family.aspectRatio >= 1.05)
    .toSorted(
      (first, second) =>
        second.collisionAreaMm2 - first.collisionAreaMm2 ||
        second.maximumSideMm - first.maximumSideMm ||
        first.key.localeCompare(second.key)
    )
    .slice(0, 2)
}

/** Builds exactly four orders crossed with two relative physical-axis templates. */
export function buildIntrinsicFamilyPortfolioChromosomes(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): Effect.Effect<
  ReadonlyArray<IntrinsicFamilyPortfolioChromosome>,
  IrregularNestingNotImplementedError | IrregularGeometryInputError,
  GeometryKernel
> {
  return Effect.gen(function* () {
    const geometryKernel = yield* GeometryKernel
    const selectedFamilies = selectRepeatedElongatedFamilies(pieces)
    const prepared: PreparedChromosome[] = []
    for (const orderId of INTRINSIC_FAMILY_PORTFOLIO_ORDER_IDS) {
      const ordered = orderIntrinsicFamilyPortfolioPieces(pieces, orderId)
      for (const templateId of INTRINSIC_FAMILY_PORTFOLIO_TEMPLATE_IDS) {
        prepared.push(
          yield* restrictOrientationTemplate(
            orderId,
            ordered,
            selectedFamilies,
            templateId,
            geometryKernel
          )
        )
      }
    }

    const identities = new Map<string, string>()
    return prepared.map((chromosome) => {
      const pieceIds = chromosome.pieces.map(preparedPieceId)
      if (chromosome.invalidReason !== undefined) {
        return {
          ...chromosome,
          status: 'invalid' as const,
          invalidReason: chromosome.invalidReason,
          duplicateOf: undefined,
          identitySha256: undefined,
          pieceIds
        }
      }
      const identity = chromosomeIdentity(chromosome.pieces)
      const identitySha256 = createHash('sha256').update(identity).digest('hex')
      const duplicateOf = identities.get(identity)
      if (duplicateOf !== undefined) {
        return {
          ...chromosome,
          status: 'duplicate' as const,
          invalidReason: undefined,
          duplicateOf,
          identitySha256,
          pieceIds
        }
      }
      const label = `${chromosome.orderId}/${chromosome.templateId}`
      identities.set(identity, label)
      return {
        ...chromosome,
        status: 'valid' as const,
        invalidReason: undefined,
        duplicateOf: undefined,
        identitySha256,
        pieceIds
      }
    })
  })
}

/** Runs the bounded sheetless E1 decoder archive for every valid unique chromosome. */
export function runIntrinsicStrictFamilyPortfolio(
  finalSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  options: {
    readonly maximumRuntimeMsPerChromosome?: number
    readonly maximumTotalRuntimeMs?: number
  } = {}
): Effect.Effect<
  IntrinsicFamilyPortfolioResult,
  PortfolioError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const maximumRuntimeMsPerChromosome = options.maximumRuntimeMsPerChromosome ?? 30_000
    const maximumTotalRuntimeMs = options.maximumTotalRuntimeMs ?? 240_000
    const chromosomes = yield* buildIntrinsicFamilyPortfolioChromosomes(pieces)
    const runs: IntrinsicFamilyPortfolioRun[] = []
    for (const chromosome of chromosomes) {
      if (chromosome.status !== 'valid') {
        runs.push({ chromosome, status: chromosome.status, result: undefined, runtimeMs: 0 })
        continue
      }
      const elapsedMs = performance.now() - startedAt
      const remainingMs = maximumTotalRuntimeMs - elapsedMs
      if (remainingMs <= 0) {
        runs.push({
          chromosome,
          status: 'global-deadline',
          result: undefined,
          runtimeMs: 0
        })
        continue
      }
      const decodeStartedAt = performance.now()
      const result = yield* decodeIntrinsicStrictPriorityOrder(finalSheet, chromosome.pieces, {
        comparatorMode: 'pure-growth',
        maximumRuntimeMs: Math.min(maximumRuntimeMsPerChromosome, remainingMs)
      }).pipe(
        Effect.map((value) => ({ status: value.status, value })),
        Effect.catchTag('IrregularNfpIfpControlAbortError', () =>
          Effect.succeed({ status: 'deadline' as const, value: undefined })
        )
      )
      runs.push({
        chromosome,
        status: result.status,
        result: result.value,
        runtimeMs: performance.now() - decodeStartedAt
      })
    }
    const completed = runs.filter(
      (run): run is IntrinsicFamilyPortfolioRun & { result: IntrinsicStrictDecodeResult } =>
        run.status === 'completed' && run.result?.metrics !== undefined
    )
    const { archive, winner } = selectIntrinsicFamilyPortfolioWinner(completed)
    return {
      chromosomes,
      runs,
      archive,
      winner,
      runtimeMs: performance.now() - startedAt
    }
  })
}

/** Selects the portfolio finalist only through the existing sheet-free archive order. */
export function selectIntrinsicFamilyPortfolioWinner(
  runs: ReadonlyArray<IntrinsicFamilyPortfolioRun>
): {
  readonly archive: ReadonlyArray<IntrinsicStrictCompletedMetrics>
  readonly winner: IntrinsicFamilyPortfolioRun | undefined
} {
  const archive = rankIntrinsicStrictCompletedLayouts(
    runs.flatMap((run) => (run.result?.metrics === undefined ? [] : [run.result.metrics]))
  )
  const winningHash = archive[0]?.canonicalGeometryHash
  return {
    archive,
    winner:
      winningHash === undefined
        ? undefined
        : runs.find((run) => run.result?.metrics?.canonicalGeometryHash === winningHash)
  }
}

function familyRoundRobin(
  pieces: ReadonlyArray<IrregularPreparedPiece>
): ReadonlyArray<IrregularPreparedPiece> {
  const families = groupIntrinsicCollisionFamilies(pieces).toSorted(
    (first, second) => first.firstBaselineIndex - second.firstBaselineIndex
  )
  const result: IrregularPreparedPiece[] = []
  const queues = families.map((family) => [...family.members])
  while (queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const piece = queue.shift()
      if (piece !== undefined) result.push(piece)
    }
  }
  return result
}

function restrictOrientationTemplate(
  orderId: IntrinsicFamilyPortfolioOrderId,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  selectedFamilies: ReadonlyArray<IntrinsicCollisionFamily>,
  templateId: IntrinsicFamilyPortfolioTemplateId,
  geometryKernel: GeometryKernel.Service
): Effect.Effect<
  PreparedChromosome,
  IrregularNestingNotImplementedError | IrregularGeometryInputError
> {
  return Effect.gen(function* () {
    if (selectedFamilies.length < 2) {
      return {
        orderId,
        templateId,
        selectedElongatedFamilyKeys: selectedFamilies.map(({ key }) => key),
        pieces: [],
        invalidReason: 'fewer than two repeated elongated collision families'
      }
    }
    const requiredAxis = new Map<string, 'landscape' | 'portrait'>([
      [selectedFamilies[0]?.key ?? '', 'landscape'],
      [selectedFamilies[1]?.key ?? '', templateId === 'coaxial' ? 'landscape' : 'portrait']
    ])
    const restricted: IrregularPreparedPiece[] = []
    for (const piece of pieces) {
      const axis = requiredAxis.get(intrinsicCollisionFamilyKey(piece))
      if (axis === undefined) {
        restricted.push(piece)
        continue
      }
      const transforms: IrregularTransformCandidate[] = []
      for (const transform of piece.transforms) {
        const transformed = yield* geometryKernel.transformCollisionGeometry({
          geometry: piece.collisionGeometry,
          transform
        })
        if (matchesPhysicalLongAxis(transformed, axis)) transforms.push(transform)
      }
      if (transforms.length === 0) {
        return {
          orderId,
          templateId,
          selectedElongatedFamilyKeys: selectedFamilies.map(({ key }) => key),
          pieces: [],
          invalidReason: `selected family ${intrinsicCollisionFamilyKey(piece)} has no ${axis} transform`
        }
      }
      restricted.push(new IrregularPreparedPiece({ ...piece, transforms }))
    }
    return {
      orderId,
      templateId,
      selectedElongatedFamilyKeys: selectedFamilies.map(({ key }) => key),
      pieces: restricted,
      invalidReason: undefined
    }
  })
}

function matchesPhysicalLongAxis(
  transformed: TransformedCollisionGeometry,
  axis: 'landscape' | 'portrait'
): boolean {
  const width = transformed.bounds.maxX - transformed.bounds.minX
  const height = transformed.bounds.maxY - transformed.bounds.minY
  return axis === 'landscape' ? width >= height : height > width
}

function chromosomeIdentity(pieces: ReadonlyArray<IrregularPreparedPiece>): string {
  return JSON.stringify(
    pieces.map((piece) => [
      preparedPieceId(piece),
      piece.transforms
        .map(
          (transform) =>
            [normalizeRotationDeg(transform.rotationDeg), Number(transform.mirrored)] as const
        )
        .toSorted((first, second) =>
          first[0] === second[0] ? first[1] - second[1] : first[0] - second[0]
        )
    ])
  )
}

function normalizeRotationDeg(rotationDeg: number): number {
  const remainder = rotationDeg % 360
  const normalized = remainder < 0 ? remainder + 360 : remainder
  return Object.is(normalized, -0) ? 0 : normalized
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function collisionAreaMm2(piece: IrregularPreparedPiece): number {
  return measureCollisionPolygon(piece.collisionGeometry.collisionPolygon.points)?.areaMm2 ?? 0
}

function collisionMaximumSideMm(piece: IrregularPreparedPiece): number {
  return (
    measureCollisionPolygon(piece.collisionGeometry.collisionPolygon.points)?.maximumSideMm ?? 0
  )
}

function measureCollisionPolygon(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>
):
  | { readonly areaMm2: number; readonly maximumSideMm: number; readonly aspectRatio: number }
  | undefined {
  if (points.length < 3) return undefined
  let doubledAreaGrid2 = 0
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index]
    const second = points[(index + 1) % points.length]
    if (first === undefined || second === undefined) return undefined
    const firstX = toGridMm(first.x)
    const firstY = toGridMm(first.y)
    const secondX = toGridMm(second.x)
    const secondY = toGridMm(second.y)
    if (
      firstX === undefined ||
      firstY === undefined ||
      secondX === undefined ||
      secondY === undefined
    ) {
      return undefined
    }
    doubledAreaGrid2 += firstX * secondY - secondX * firstY
    minX = Math.min(minX, first.x)
    minY = Math.min(minY, first.y)
    maxX = Math.max(maxX, first.x)
    maxY = Math.max(maxY, first.y)
  }
  const width = maxX - minX
  const height = maxY - minY
  const shorter = Math.min(width, height)
  const longer = Math.max(width, height)
  if (shorter <= 0 || ![width, height, doubledAreaGrid2].every(Number.isFinite)) return undefined
  return {
    areaMm2: Math.abs(doubledAreaGrid2) / 2_000_000,
    maximumSideMm: longer,
    aspectRatio: longer / shorter
  }
}

function canonicalCyclicPolygonKey(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>
): string {
  const keys = points.map((point) => {
    const x = toGridMm(point.x)
    const y = toGridMm(point.y)
    return x === undefined || y === undefined ? 'invalid' : `${x},${y}`
  })
  if (keys.length === 0) return ''
  const variants: string[] = []
  for (let start = 0; start < keys.length; start += 1) {
    variants.push(cyclicKeys(keys, start, 1), cyclicKeys(keys, start, -1))
  }
  return variants.toSorted()[0] ?? ''
}

function cyclicKeys(keys: ReadonlyArray<string>, start: number, direction: 1 | -1): string {
  const result: string[] = []
  for (let offset = 0; offset < keys.length; offset += 1) {
    result.push(keys[(start + direction * offset + keys.length * 2) % keys.length] ?? '')
  }
  return result.join(';')
}
