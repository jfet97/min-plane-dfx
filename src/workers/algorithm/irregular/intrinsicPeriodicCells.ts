import { Effect, Order } from 'effect'
import {
  area,
  booleanOpWithPolyTree,
  ClipType,
  FillRule,
  type Path64,
  type PolyPath64,
  PolyTree64
} from 'clipper2-ts'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPreparedPiece,
  type IrregularNestingSettings,
  IrregularTransform,
  TransformedCollisionGeometry,
  type IrregularPoint,
  type IrregularTransformCandidate
} from '@shared/irregular/domain.js'
import { fromGrid, toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import { boundsForPoints, translatePolygonWithBounds } from '../../irregular/convexBounds.js'
import { sharedConvexPolygonBoundaryLength } from '../../irregular/convexPolygonContact.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import { PlacementValidation } from '../../irregular/placementValidation.js'
import {
  canonicalCollisionLayoutIdentity,
  measureCanonicalLayoutTopology
} from '../../irregular/canonicalLayoutGeometry.js'
import {
  type IrregularGeometryInputError,
  type IrregularNestingNotImplementedError,
  NfpIfpService
} from '../../irregular/services.js'
import {
  groupIntrinsicCollisionFamilies,
  type IntrinsicCollisionFamily
} from './intrinsicStrictFamilyPortfolio.js'

const transformOrder = Order.combineAll<IrregularTransformCandidate>([
  Order.mapInput(Order.Number, ({ index }) => index),
  Order.mapInput(Order.Number, ({ rotationDeg }) => rotationDeg),
  Order.mapInput(Order.Boolean, ({ mirrored }) => mirrored)
])

export interface IntrinsicPeriodicVector {
  readonly x: number
  readonly y: number
}

export interface IntrinsicPeriodicBaseMember {
  readonly piece: IrregularPreparedPiece
  readonly geometry: TransformedCollisionGeometry
  readonly point: IrregularPoint
}

export interface IntrinsicPeriodicCell {
  readonly role: 'P1' | 'P2'
  readonly familyKey: string
  readonly members: ReadonlyArray<IntrinsicPeriodicBaseMember>
  readonly v1: IntrinsicPeriodicVector
  readonly v2: IntrinsicPeriodicVector
  readonly determinantGrid2: string
  readonly memberDoubledAreaGrid2: string
  readonly density: number
  readonly envelopeMaximumSideMm: number
  readonly hullWasteRatio: number
  readonly sharedBoundaryLengthMm: number
  readonly canonicalKey: string
}

export interface IntrinsicPeriodicCatalog {
  readonly familyCoverageComplete: boolean
  readonly runtimeCoverageComplete: boolean
  readonly families: ReadonlyArray<IntrinsicPeriodicFamilyCatalog>
  readonly selectedFamilyKey: string | undefined
  readonly uniqueTransformCount: number
  readonly enumeratedPairCount: number
  readonly cells: ReadonlyArray<IntrinsicPeriodicCell>
  readonly rejected: Readonly<Record<string, number>>
}

export interface IntrinsicPeriodicCatalogOptions {
  readonly maximumRuntimeMs?: number
  readonly maximumFamilyCount?: number
  readonly maximumTransformsPerFamily?: number
  readonly maximumPairsPerFamily?: number
  readonly maximumCellsPerFamilyRole?: number
}

export interface IntrinsicPeriodicTransformReservation {
  readonly key: string
  readonly availableCount: number
  readonly retainedCount: number
}

export interface IntrinsicPeriodicFamilyCatalog {
  readonly familyKey: string
  readonly memberCount: number
  readonly collisionAreaMm2: number
  readonly uniqueTransformCount: number
  readonly retainedTransformCount: number
  readonly transformCoverageComplete: boolean
  readonly transformReservations: ReadonlyArray<IntrinsicPeriodicTransformReservation>
  readonly enumeratedPairCount: number
  readonly pairCoverageComplete: boolean
  readonly cellCoverageComplete: boolean
  readonly cells: ReadonlyArray<IntrinsicPeriodicCell>
  readonly rejected: Readonly<Record<string, number>>
}

export interface IntrinsicPeriodicSeed {
  readonly role: 'P1' | 'P2'
  readonly cellKey: string
  readonly placements: ReadonlyArray<IrregularPlacedPiece>
  readonly remainingFamilyMembers: ReadonlyArray<IrregularPreparedPiece>
  readonly componentCount: number
  readonly isolatedPieceCount: number
  readonly largestComponentSize: number
  readonly maximumSideMm: number
  readonly envelopeAreaMm2: number
  readonly envelopeSpanMm: number
  readonly canonicalKey: string
}

interface GridPoint {
  readonly x: bigint
  readonly y: bigint
}

interface Rational {
  readonly numerator: bigint
  readonly denominator: bigint
}

interface RationalPoint {
  readonly x: Rational
  readonly y: Rational
}

interface ForbiddenBoundary {
  readonly points: ReadonlyArray<GridPoint>
  readonly isHole?: boolean
}

/** Enumerates a bounded exact repeated-family one- and two-transform periodic cell catalog. */
export function enumerateIntrinsicPeriodicCells(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  options: number | IntrinsicPeriodicCatalogOptions = {}
): Effect.Effect<
  IntrinsicPeriodicCatalog,
  IrregularNestingNotImplementedError | IrregularGeometryInputError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const resolved = resolveCatalogOptions(options)
    const startedAt = performance.now()
    const geometryKernel = yield* GeometryKernel
    const nfp = yield* NfpIfpService
    const settings = yield* GeometrySettings
    const eligibleFamilies = groupIntrinsicCollisionFamilies(pieces)
      .filter(({ members }) => members.length >= 2)
      .toSorted(
        (first, second) =>
          second.members.length - first.members.length ||
          second.members.length * second.collisionAreaMm2 -
            first.members.length * first.collisionAreaMm2 ||
          first.key.localeCompare(second.key)
      )
    const selectedFamilies = eligibleFamilies.slice(0, resolved.maximumFamilyCount)
    const familyCoverageComplete = selectedFamilies.length === eligibleFamilies.length
    if (selectedFamilies.length === 0) {
      return {
        familyCoverageComplete,
        runtimeCoverageComplete: true,
        families: [],
        selectedFamilyKey: undefined,
        uniqueTransformCount: 0,
        enumeratedPairCount: 0,
        cells: [],
        rejected: {}
      }
    }
    const families: IntrinsicPeriodicFamilyCatalog[] = []
    const globalCells = new Map<string, IntrinsicPeriodicCell>()
    for (const family of selectedFamilies) {
      if (performance.now() - startedAt >= resolved.maximumRuntimeMs) break
      const catalog = yield* enumerateIntrinsicPeriodicFamily({
        family,
        geometryKernel,
        nfp,
        settings,
        startedAt,
        options: resolved
      })
      families.push(catalog)
      for (const cell of catalog.cells) globalCells.set(cell.canonicalKey, cell)
    }
    const first = families[0]
    return {
      familyCoverageComplete,
      runtimeCoverageComplete: performance.now() - startedAt < resolved.maximumRuntimeMs,
      families,
      selectedFamilyKey: first?.familyKey,
      uniqueTransformCount: first?.retainedTransformCount ?? 0,
      enumeratedPairCount: first?.enumeratedPairCount ?? 0,
      cells: rankIntrinsicPeriodicCells([...globalCells.values()]),
      rejected: mergeRejections(families.map(({ rejected }) => rejected))
    }
  })
}

interface ResolvedIntrinsicPeriodicCatalogOptions {
  readonly maximumRuntimeMs: number
  readonly maximumFamilyCount: number
  readonly maximumTransformsPerFamily: number
  readonly maximumPairsPerFamily: number
  readonly maximumCellsPerFamilyRole: number
}

function resolveCatalogOptions(
  options: number | IntrinsicPeriodicCatalogOptions
): ResolvedIntrinsicPeriodicCatalogOptions {
  const input = typeof options === 'number' ? { maximumRuntimeMs: options } : options
  return {
    maximumRuntimeMs: input.maximumRuntimeMs ?? 15_000,
    maximumFamilyCount: input.maximumFamilyCount ?? 8,
    maximumTransformsPerFamily: input.maximumTransformsPerFamily ?? 16,
    maximumPairsPerFamily: input.maximumPairsPerFamily ?? 120,
    maximumCellsPerFamilyRole: input.maximumCellsPerFamilyRole ?? 4
  }
}

function enumerateIntrinsicPeriodicFamily(input: {
  readonly family: IntrinsicCollisionFamily
  readonly geometryKernel: GeometryKernel.Service
  readonly nfp: NfpIfpService
  readonly settings: IrregularNestingSettings
  readonly startedAt: number
  readonly options: ResolvedIntrinsicPeriodicCatalogOptions
}): Effect.Effect<
  IntrinsicPeriodicFamilyCatalog,
  IrregularNestingNotImplementedError | IrregularGeometryInputError
> {
  return Effect.gen(function* () {
    const representative = input.family.members[0]
    if (representative === undefined) {
      return emptyIntrinsicPeriodicFamilyCatalog(input.family, { missingRepresentative: 1 })
    }
    const transformedByCanonicalKey = new Map<
      string,
      { readonly geometry: TransformedCollisionGeometry; readonly transform: IrregularTransformCandidate }
    >()
    let runtimeCoverageComplete = true
    for (const transform of [...representative.transforms].sort(transformOrder)) {
      if (performance.now() - input.startedAt >= input.options.maximumRuntimeMs) {
        runtimeCoverageComplete = false
        break
      }
      const geometry = yield* input.geometryKernel.transformCollisionGeometry({
        geometry: representative.collisionGeometry,
        transform
      })
      const key = canonicalTransformedPolygonKey(geometry)
      if (!transformedByCanonicalKey.has(key)) transformedByCanonicalKey.set(key, { geometry, transform })
    }
    const transformed = selectPeriodicTransformRepresentatives(
      [...transformedByCanonicalKey.values()],
      input.options.maximumTransformsPerFamily
    )
    const transformCoverageComplete =
      runtimeCoverageComplete && transformed.length === transformedByCanonicalKey.size
    const rejected = new Map<string, number>()
    const p1: IntrinsicPeriodicCell[] = []
    const p2: IntrinsicPeriodicCell[] = []
    const addDerived = (
      target: IntrinsicPeriodicCell[],
      derived: ReadonlyArray<IntrinsicPeriodicCell>,
      emptyReason: string
    ) => {
      if (derived.length === 0) rejected.set(emptyReason, (rejected.get(emptyReason) ?? 0) + 1)
      target.push(...derived)
    }

    for (const { geometry } of transformed) {
      if (performance.now() - input.startedAt >= input.options.maximumRuntimeMs) {
        runtimeCoverageComplete = false
        break
      }
      const point = anchorPoint(geometry)
      const derived = yield* deriveCells({
        role: 'P1',
        familyKey: input.family.key,
        members: [{ piece: representative, geometry, point }],
        nfp: input.nfp,
        settings: input.settings
      })
      addDerived(p1, derived.cells, 'noP1Basis')
      mergeRejectedCounts(rejected, derived.rejected)
    }

    let enumeratedPairCount = 0
    let pairCoverageComplete = true
    for (let firstIndex = 0; firstIndex < transformed.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < transformed.length; secondIndex += 1) {
        if (enumeratedPairCount >= input.options.maximumPairsPerFamily) {
          pairCoverageComplete = false
          break
        }
        if (performance.now() - input.startedAt >= input.options.maximumRuntimeMs) {
          runtimeCoverageComplete = false
          pairCoverageComplete = false
          break
        }
        enumeratedPairCount += 1
        const first = transformed[firstIndex]?.geometry
        const second = transformed[secondIndex]?.geometry
        if (first === undefined || second === undefined) continue
        const firstPoint = anchorPoint(first)
        const fixed = makePlaced(representative, first, firstPoint)
        const pairNfp = yield* input.nfp.computeNfp({
          fixed,
          moving: second,
          settings: input.settings.geometry
        })
        const offsets = boundaryCandidatePoints(pairNfp.boundary.points, second)
        for (const point of offsets) {
          if (performance.now() - input.startedAt >= input.options.maximumRuntimeMs) {
            runtimeCoverageComplete = false
            pairCoverageComplete = false
            break
          }
          const legal = yield* PlacementValidation.checkSheetless({
            placed: [fixed],
            moving: second,
            candidate: makeCandidate(second, point)
          })
          if (!legal || !combinedBoundsNonnegative([first, second], [firstPoint, point])) continue
          const derived = yield* deriveCells({
            role: 'P2',
            familyKey: input.family.key,
            members: [
              { piece: representative, geometry: first, point: firstPoint },
              { piece: input.family.members[1] ?? representative, geometry: second, point }
            ],
            nfp: input.nfp,
            settings: input.settings
          })
          addDerived(p2, derived.cells, 'noP2Basis')
          mergeRejectedCounts(rejected, derived.rejected)
        }
      }
      if (!pairCoverageComplete) break
    }

    const p1Front = periodicCellFront(p1, input.options.maximumCellsPerFamilyRole)
    const p2Front = periodicCellFront(p2, input.options.maximumCellsPerFamilyRole)
    const cells = [...p1Front.cells, ...p2Front.cells]
    if (!p1Front.coverageComplete) rejected.set('p1FrontierTruncated', 1)
    if (!p2Front.coverageComplete) rejected.set('p2FrontierTruncated', 1)
    return {
      familyKey: input.family.key,
      memberCount: input.family.members.length,
      collisionAreaMm2: input.family.collisionAreaMm2,
      uniqueTransformCount: transformedByCanonicalKey.size,
      retainedTransformCount: transformed.length,
      transformCoverageComplete,
      transformReservations: measureTransformReservations(
        [...transformedByCanonicalKey.values()],
        transformed
      ),
      enumeratedPairCount,
      pairCoverageComplete,
      cellCoverageComplete:
        runtimeCoverageComplete && pairCoverageComplete && p1Front.coverageComplete && p2Front.coverageComplete,
      cells: rankIntrinsicPeriodicCells(cells),
      rejected: Object.fromEntries([...rejected.entries()].toSorted())
    }
  })
}

function emptyIntrinsicPeriodicFamilyCatalog(
  family: IntrinsicCollisionFamily,
  rejected: Readonly<Record<string, number>>
): IntrinsicPeriodicFamilyCatalog {
  return {
    familyKey: family.key,
    memberCount: family.members.length,
    collisionAreaMm2: family.collisionAreaMm2,
    uniqueTransformCount: 0,
    retainedTransformCount: 0,
    transformCoverageComplete: true,
    transformReservations: [],
    enumeratedPairCount: 0,
    pairCoverageComplete: true,
    cellCoverageComplete: true,
    cells: [],
    rejected
  }
}

function selectPeriodicTransformRepresentatives(
  transformed: ReadonlyArray<{
    readonly geometry: TransformedCollisionGeometry
    readonly transform: IrregularTransformCandidate
  }>,
  maximumTransforms: number
): ReadonlyArray<{ readonly geometry: TransformedCollisionGeometry; readonly transform: IrregularTransformCandidate }> {
  const ordered = [...transformed].toSorted((first, second) => transformOrder(first.transform, second.transform))
  const reserved = new Map<string, (typeof ordered)[number]>()
  for (const candidate of ordered) {
    const key = periodicTransformReservationKey(candidate.transform)
    if (!reserved.has(key)) reserved.set(key, candidate)
  }
  const result = [...reserved.values()]
  for (const candidate of ordered) {
    if (result.length >= maximumTransforms) break
    if (!result.includes(candidate)) result.push(candidate)
  }
  return result.slice(0, maximumTransforms)
}

function periodicTransformReservationKey(transform: IrregularTransformCandidate): string {
  const normalized = ((transform.rotationDeg % 360) + 360) % 360
  const rotationFamily = transform.reason === 'orthogonal' ? `q${Math.round(normalized / 90) % 4}` : transform.reason
  return `${transform.mirrored ? 'mirror' : 'direct'}:${rotationFamily}`
}

function measureTransformReservations(
  all: ReadonlyArray<{ readonly geometry: TransformedCollisionGeometry; readonly transform: IrregularTransformCandidate }>,
  retained: ReadonlyArray<{
    readonly geometry: TransformedCollisionGeometry
    readonly transform: IrregularTransformCandidate
  }>
): ReadonlyArray<IntrinsicPeriodicTransformReservation> {
  const counts = new Map<string, { availableCount: number; retainedCount: number }>()
  for (const { transform } of all) {
    const key = periodicTransformReservationKey(transform)
    const value = counts.get(key) ?? { availableCount: 0, retainedCount: 0 }
    counts.set(key, { ...value, availableCount: value.availableCount + 1 })
  }
  for (const { transform } of retained) {
    const key = periodicTransformReservationKey(transform)
    const value = counts.get(key) ?? { availableCount: 0, retainedCount: 0 }
    counts.set(key, { ...value, retainedCount: value.retainedCount + 1 })
  }
  return [...counts.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .toSorted((first, second) => first.key.localeCompare(second.key))
}

function periodicCellFront(
  cells: ReadonlyArray<IntrinsicPeriodicCell>,
  maximumCells: number
): { readonly cells: ReadonlyArray<IntrinsicPeriodicCell>; readonly coverageComplete: boolean } {
  const unique = new Map(cells.map((cell) => [cell.canonicalKey, cell]))
  const nonDominated = [...unique.values()].filter(
    (candidate) => ![...unique.values()].some((other) => other !== candidate && periodicCellDominates(other, candidate))
  )
  return {
    cells: rankIntrinsicPeriodicCells(nonDominated).slice(0, maximumCells),
    coverageComplete: nonDominated.length <= maximumCells
  }
}

function periodicCellDominates(first: IntrinsicPeriodicCell, second: IntrinsicPeriodicCell): boolean {
  const firstDensity = BigInt(first.memberDoubledAreaGrid2) * BigInt(second.determinantGrid2)
  const secondDensity = BigInt(second.memberDoubledAreaGrid2) * BigInt(first.determinantGrid2)
  const noWorse =
    firstDensity >= secondDensity &&
    first.envelopeMaximumSideMm <= second.envelopeMaximumSideMm &&
    first.hullWasteRatio <= second.hullWasteRatio &&
    first.sharedBoundaryLengthMm >= second.sharedBoundaryLengthMm
  const strict =
    firstDensity > secondDensity ||
    first.envelopeMaximumSideMm < second.envelopeMaximumSideMm ||
    first.hullWasteRatio < second.hullWasteRatio ||
    first.sharedBoundaryLengthMm > second.sharedBoundaryLengthMm
  return noWorse && strict
}

function mergeRejections(
  rejections: ReadonlyArray<Readonly<Record<string, number>>>
): Readonly<Record<string, number>> {
  const result = new Map<string, number>()
  for (const rejected of rejections) {
    for (const [key, count] of Object.entries(rejected)) result.set(key, (result.get(key) ?? 0) + count)
  }
  return Object.fromEntries([...result.entries()].toSorted())
}

/** Expands one certified cell into every bounded finite crop and keeps its best topology. */
export function expandIntrinsicPeriodicCell(
  cell: IntrinsicPeriodicCell,
  familyMembers: ReadonlyArray<IrregularPreparedPiece>,
  maximumCrops = 2
): Effect.Effect<ReadonlyArray<IntrinsicPeriodicSeed>, IrregularGeometryInputError> {
  return Effect.gen(function* () {
    const memberCount = cell.members.length
    const q = Math.floor(familyMembers.length / memberCount)
    if (q < 1) return []
    const candidates: IntrinsicPeriodicSeed[] = []
    const identities = new Set<string>()
    for (let rows = 1; rows <= q; rows += 1) {
      const columns = Math.ceil(q / rows)
      for (const traversal of ['row', 'column'] as const) {
        for (const corner of [0, 1, 2, 3] as const) {
          const coordinates = cropCoordinates(rows, columns, q, traversal, corner)
          const placed: IrregularPlacedPiece[] = []
          let sourceIndex = 0
          let legal = true
          for (const coordinate of coordinates) {
            for (const base of cell.members) {
              const piece = familyMembers[sourceIndex]
              if (piece === undefined) break
              const point = {
                x: base.point.x + coordinate.row * cell.v1.x + coordinate.column * cell.v2.x,
                y: base.point.y + coordinate.row * cell.v1.y + coordinate.column * cell.v2.y
              }
              const actualGeometry = geometryForPiece(base.geometry, piece)
              const candidate = makeCandidate(actualGeometry, point)
              if (
                !(yield* PlacementValidation.checkSheetless({
                  placed,
                  moving: actualGeometry,
                  candidate
                }))
              ) {
                legal = false
                break
              }
              placed.push(makePlaced(piece, actualGeometry, point))
              sourceIndex += 1
            }
            if (!legal || sourceIndex >= q * memberCount) break
          }
          if (!legal || placed.length !== q * memberCount) continue
          const normalized = normalizePlacedBottomLeft(placed)
          const identity = canonicalCollisionLayoutIdentity(normalized)
          const topology = measureCanonicalLayoutTopology(normalized)
          const bounds = placedBounds(normalized)
          if (
            identity === undefined ||
            topology === undefined ||
            bounds === undefined ||
            identities.has(identity)
          ) {
            continue
          }
          identities.add(identity)
          candidates.push({
            role: cell.role,
            cellKey: cell.canonicalKey,
            placements: normalized,
            remainingFamilyMembers: familyMembers.slice(q * memberCount),
            componentCount: topology.positiveContactComponentCount,
            isolatedPieceCount: topology.isolatedPieceCount,
            largestComponentSize: topology.largestPositiveContactComponentSize,
            maximumSideMm: Math.max(bounds.width, bounds.height),
            envelopeAreaMm2: bounds.width * bounds.height,
            envelopeSpanMm: bounds.width + bounds.height,
            canonicalKey: identity
          })
        }
      }
    }
    return periodicSeedFront(candidates, maximumCrops)
  })
}

function cropCoordinates(
  rows: number,
  columns: number,
  count: number,
  traversal: 'row' | 'column',
  corner: 0 | 1 | 2 | 3
): ReadonlyArray<{ readonly row: number; readonly column: number }> {
  const coordinates: Array<{ readonly row: number; readonly column: number }> = []
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) coordinates.push({ row, column })
  }
  const ordered = coordinates.toSorted((first, second) =>
    traversal === 'row'
      ? first.row - second.row || first.column - second.column
      : first.column - second.column || first.row - second.row
  )
  return ordered.slice(0, count).map(({ row, column }) => ({
    row: corner === 1 || corner === 2 ? rows - 1 - row : row,
    column: corner === 2 || corner === 3 ? columns - 1 - column : column
  }))
}

function compareSeeds(first: IntrinsicPeriodicSeed, second: IntrinsicPeriodicSeed): number {
  return (
    first.componentCount - second.componentCount ||
    first.isolatedPieceCount - second.isolatedPieceCount ||
    second.largestComponentSize - first.largestComponentSize ||
    first.maximumSideMm - second.maximumSideMm ||
    first.envelopeAreaMm2 - second.envelopeAreaMm2 ||
    first.envelopeSpanMm - second.envelopeSpanMm ||
    first.canonicalKey.localeCompare(second.canonicalKey)
  )
}

/** Topology-first finite periodic expansion order across certified cells. */
export function rankIntrinsicPeriodicSeeds(
  seeds: ReadonlyArray<IntrinsicPeriodicSeed>
): ReadonlyArray<IntrinsicPeriodicSeed> {
  return seeds.toSorted(compareSeeds)
}

function periodicSeedFront(
  seeds: ReadonlyArray<IntrinsicPeriodicSeed>,
  maximumCrops: number
): ReadonlyArray<IntrinsicPeriodicSeed> {
  const nonDominated = seeds.filter(
    (candidate) => !seeds.some((other) => other !== candidate && periodicSeedDominates(other, candidate))
  )
  return rankIntrinsicPeriodicSeeds(nonDominated).slice(0, maximumCrops)
}

function periodicSeedDominates(first: IntrinsicPeriodicSeed, second: IntrinsicPeriodicSeed): boolean {
  const noWorse =
    first.componentCount <= second.componentCount &&
    first.isolatedPieceCount <= second.isolatedPieceCount &&
    first.largestComponentSize >= second.largestComponentSize &&
    first.maximumSideMm <= second.maximumSideMm &&
    first.envelopeAreaMm2 <= second.envelopeAreaMm2 &&
    first.envelopeSpanMm <= second.envelopeSpanMm
  const strict =
    first.componentCount < second.componentCount ||
    first.isolatedPieceCount < second.isolatedPieceCount ||
    first.largestComponentSize > second.largestComponentSize ||
    first.maximumSideMm < second.maximumSideMm ||
    first.envelopeAreaMm2 < second.envelopeAreaMm2 ||
    first.envelopeSpanMm < second.envelopeSpanMm
  return noWorse && strict
}

function normalizePlacedBottomLeft(
  placed: ReadonlyArray<IrregularPlacedPiece>
): ReadonlyArray<IrregularPlacedPiece> {
  const bounds = placedBounds(placed)
  if (bounds === undefined) return []
  return placed.map(
    ({ placement, collisionGeometry }) =>
      new IrregularPlacedPiece({
        placement: new IrregularPlacement({
          ...placement,
          transform: new IrregularTransform({
            ...placement.transform,
            translateX: placement.transform.translateX - bounds.minX,
            translateY: placement.transform.translateY - bounds.minY
          })
        }),
        collisionGeometry
      })
  )
}

function placedBounds(placed: ReadonlyArray<IrregularPlacedPiece>):
  | {
      readonly minX: number
      readonly minY: number
      readonly maxX: number
      readonly maxY: number
      readonly width: number
      readonly height: number
    }
  | undefined {
  const points = placed.flatMap(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
  const bounds = boundsForPoints(points)
  return bounds === undefined
    ? undefined
    : { ...bounds, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY }
}

interface IntrinsicPeriodicCellDerivation {
  readonly cells: ReadonlyArray<IntrinsicPeriodicCell>
  readonly rejected: Readonly<Record<string, number>>
}

function deriveCells(input: {
  readonly role: 'P1' | 'P2'
  readonly familyKey: string
  readonly members: ReadonlyArray<IntrinsicPeriodicBaseMember>
  readonly nfp: NfpIfpService
  readonly settings: IrregularNestingSettings
}): Effect.Effect<
  IntrinsicPeriodicCellDerivation,
  IrregularNestingNotImplementedError | IrregularGeometryInputError
> {
  return Effect.gen(function* () {
    const forbidden: ForbiddenBoundary[] = []
    for (const fixedMember of input.members) {
      for (const movingMember of input.members) {
        const boundary = yield* input.nfp.computeNfp({
          fixed: makePlaced(fixedMember.piece, fixedMember.geometry, fixedMember.point),
          moving: movingMember.geometry,
          settings: input.settings.geometry
        })
        const movingGrid = gridPoint(movingMember.point)
        if (movingGrid === undefined) return { cells: [], rejected: { invalidMovingGrid: 1 } }
        const points = boundary.boundary.points
          .map(gridPoint)
          .filter((point): point is GridPoint => point !== undefined)
        const shiftedPoints = shiftOrderedPairForbiddenBoundary(points, movingGrid)
        if (points.length !== boundary.boundary.points.length) {
          return { cells: [], rejected: { invalidForbiddenGrid: 1 } }
        }
        forbidden.push({ points: shiftedPoints })
      }
    }
    const bases = [
      ...deriveAxisBasisCandidates(forbidden, false),
      ...deriveAxisBasisCandidates(forbidden, true)
    ]
    const result: IntrinsicPeriodicCell[] = []
    const rejected = new Map<string, number>()
    if (bases.length === 0) rejected.set('axisBasisUnavailable', 1)
    for (const [rawV1, rawV2] of bases) {
      const canonical = canonicalizeBasis(rawV1, rawV2)
      if (canonical === undefined) {
        rejected.set('degenerateBasis', (rejected.get('degenerateBasis') ?? 0) + 1)
        continue
      }
      if (!farNeighborCertificate(input.members, canonical)) {
        rejected.set('farNeighborRejected', (rejected.get('farNeighborRejected') ?? 0) + 1)
        continue
      }
      const certificate = yield* validateLattice(input.members, canonical)
      if (certificate === undefined) {
        rejected.set('threeByThreeLatticeRejected', (rejected.get('threeByThreeLatticeRejected') ?? 0) + 1)
        continue
      }
      const determinantGrid2 = absBigInt(crossGrid(canonical[0], canonical[1]))
      const memberDoubledAreaGrid2 = input.members.reduce(
        (sum, member) => sum + polygonAreaGrid2(member.geometry, member.point),
        0n
      )
      const shape = measureBaseCellShape(input.members)
      if (shape === undefined) {
        rejected.set('baseShapeRejected', (rejected.get('baseShapeRejected') ?? 0) + 1)
        continue
      }
      const canonicalKey = canonicalCellKey(input.role, input.members, canonical)
      result.push({
        role: input.role,
        familyKey: input.familyKey,
        members: input.members,
        v1: fromGridPoint(canonical[0]),
        v2: fromGridPoint(canonical[1]),
        determinantGrid2: determinantGrid2.toString(),
        memberDoubledAreaGrid2: memberDoubledAreaGrid2.toString(),
        density: Number(memberDoubledAreaGrid2) / (2 * Number(determinantGrid2)),
        envelopeMaximumSideMm: shape.maximumSideMm,
        hullWasteRatio: shape.hullWasteRatio,
        sharedBoundaryLengthMm: certificate.sharedBoundaryLengthMm,
        canonicalKey
      })
    }
    return { cells: result, rejected: Object.fromEntries([...rejected.entries()].toSorted()) }
  })
}

function mergeRejectedCounts(
  target: Map<string, number>,
  incoming: Readonly<Record<string, number>>
): void {
  for (const [reason, count] of Object.entries(incoming)) {
    target.set(reason, (target.get(reason) ?? 0) + count)
  }
}

function deriveAxisBasis(
  boundaries: ReadonlyArray<ForbiddenBoundary>,
  swapAxes: boolean
): readonly [GridPoint, GridPoint] | undefined {
  return deriveAxisBasisCandidates(boundaries, swapAxes)[0]
}

function deriveAxisBasisCandidates(
  boundaries: ReadonlyArray<ForbiddenBoundary>,
  swapAxes: boolean
): ReadonlyArray<readonly [GridPoint, GridPoint]> {
  const orientedRaw = boundaries.map(({ points, isHole }) => ({
    points: points.map((point) => (swapAxes ? { x: point.y, y: point.x } : point)),
    ...(isHole !== undefined ? { isHole } : {})
  }))
  const oriented = unionForbiddenBoundaries(orientedRaw)
  if (oriented === undefined) return []
  const axisIntersection = boundaryLineIntersections(oriented, 'y', 0n)
    .filter(({ x }) => compareRational(x, rational(0n)) > 0)
    .toSorted((first, second) => compareRational(first.x, second.x))[0]
  if (axisIntersection === undefined) return []
  const unswap = (point: GridPoint): GridPoint => (swapAxes ? { x: point.y, y: point.x } : point)
  const result = new Map<string, readonly [GridPoint, GridPoint]>()
  for (const axisX of canonicalGridAlternatives(axisIntersection.x).filter((value) => value > 0n)) {
    const axis = { x: axisX, y: 0n }
    const shifted = unionForbiddenBoundaries([
      ...oriented,
      ...oriented.map(({ points, isHole }) => ({
        points: points.map((point) => ({ x: point.x + axis.x, y: point.y })),
        ...(isHole !== undefined ? { isHole } : {})
      }))
    ])
    if (shifted === undefined) continue
    const constrained = [
      ...shifted.flatMap(({ points }) =>
        points.map((point): RationalPoint => ({ x: rational(point.x), y: rational(point.y) }))
      ),
      ...boundaryLineIntersections(shifted, 'x', 0n),
      ...boundaryLineIntersections(shifted, 'x', axis.x)
    ]
      .filter(
        ({ x, y }) =>
          compareRational(y, rational(0n)) > 0 &&
          compareRational(x, rational(0n)) >= 0 &&
          compareRational(x, rational(axis.x)) < 0
      )
      .toSorted(
        (first, second) => compareRational(first.y, second.y) || compareRational(first.x, second.x)
      )
    const secondRational = constrained[0]
    if (secondRational === undefined) continue
    for (const secondX of canonicalGridAlternatives(secondRational.x)) {
      for (const secondY of canonicalGridAlternatives(secondRational.y)) {
        if (secondY <= 0n || secondX < 0n || secondX >= axis.x) continue
        const basis = [unswap(axis), unswap({ x: secondX, y: secondY })] as const
        result.set(`${basis[0].x},${basis[0].y};${basis[1].x},${basis[1].y}`, basis)
      }
    }
  }
  return [...result.values()]
}

/** Source-control seam for exact union plus axis-dual basis derivation. */
export function derivePeriodicAxisBasisControl(
  boundaries: ReadonlyArray<ReadonlyArray<{ readonly x: number; readonly y: number }>>,
  swapAxes = false
): readonly [IntrinsicPeriodicVector, IntrinsicPeriodicVector] | undefined {
  const converted: ForbiddenBoundary[] = boundaries.map((points) => ({
    points: points.map(({ x, y }) => ({ x: BigInt(x), y: BigInt(y) }))
  }))
  const basis = deriveAxisBasis(converted, swapAxes)
  return basis === undefined ? undefined : [fromGridPoint(basis[0]), fromGridPoint(basis[1])]
}

/** Source-control seam exposing every adjacent-grid basis candidate. */
export function derivePeriodicAxisBasisCandidatesControl(
  boundaries: ReadonlyArray<ReadonlyArray<{ readonly x: number; readonly y: number }>>,
  swapAxes = false
): ReadonlyArray<readonly [IntrinsicPeriodicVector, IntrinsicPeriodicVector]> {
  const converted: ForbiddenBoundary[] = boundaries.map((points) => ({
    points: points.map(({ x, y }) => ({ x: BigInt(x), y: BigInt(y) }))
  }))
  return deriveAxisBasisCandidates(converted, swapAxes).map(([first, second]) => [
    fromGridPoint(first),
    fromGridPoint(second)
  ])
}

/** Source-control seam proving the ordered moving-base offset sign. */
export function shiftOrderedPairForbiddenBoundaryControl(
  boundary: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  movingBasePoint: { readonly x: number; readonly y: number }
): ReadonlyArray<{ readonly x: number; readonly y: number }> {
  return boundary.map(({ x, y }) => ({
    x: x - movingBasePoint.x,
    y: y - movingBasePoint.y
  }))
}

function shiftOrderedPairForbiddenBoundary(
  boundary: ReadonlyArray<GridPoint>,
  movingBasePoint: GridPoint
): ReadonlyArray<GridPoint> {
  return boundary.map(({ x, y }) => ({
    x: x - movingBasePoint.x,
    y: y - movingBasePoint.y
  }))
}

function boundaryLineIntersections(
  boundaries: ReadonlyArray<ForbiddenBoundary>,
  axis: 'x' | 'y',
  value: bigint
): ReadonlyArray<RationalPoint> {
  const result = new Map<string, RationalPoint>()
  for (const { points } of boundaries) {
    for (let index = 0; index < points.length; index += 1) {
      const first = points[index]
      const second = points[(index + 1) % points.length]
      if (first === undefined || second === undefined) continue
      const firstValue = first[axis]
      const secondValue = second[axis]
      if (
        (value < firstValue && value < secondValue) ||
        (value > firstValue && value > secondValue)
      ) {
        continue
      }
      if (firstValue === secondValue) {
        if (firstValue === value) {
          const firstPoint = { x: rational(first.x), y: rational(first.y) }
          const secondPoint = { x: rational(second.x), y: rational(second.y) }
          result.set(rationalPointKey(firstPoint), firstPoint)
          result.set(rationalPointKey(secondPoint), secondPoint)
        }
        continue
      }
      const numerator = value - firstValue
      const denominator = secondValue - firstValue
      const otherAxis = axis === 'x' ? 'y' : 'x'
      const other = addRational(
        rational(first[otherAxis]),
        makeRational((second[otherAxis] - first[otherAxis]) * numerator, denominator)
      )
      const point: RationalPoint =
        axis === 'x' ? { x: rational(value), y: other } : { x: other, y: rational(value) }
      result.set(rationalPointKey(point), point)
    }
  }
  return [...result.values()]
}

/** Source-control seam retaining non-integral exact axis intersections. */
export function exactAxisIntersectionsControl(
  boundary: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  axis: 'x' | 'y',
  value: number
): ReadonlyArray<{ readonly x: string; readonly y: string }> {
  return boundaryLineIntersections(
    [{ points: boundary.map(({ x, y }) => ({ x: BigInt(x), y: BigInt(y) })) }],
    axis,
    BigInt(value)
  ).map(({ x, y }) => ({
    x: `${x.numerator}/${x.denominator}`,
    y: `${y.numerator}/${y.denominator}`
  }))
}

function unionForbiddenBoundaries(
  boundaries: ReadonlyArray<ForbiddenBoundary>
): ReadonlyArray<ForbiddenBoundary> | undefined {
  const paths: Path64[] = []
  for (const { points, isHole } of boundaries) {
    const path: Path64 = []
    for (const point of points) {
      const x = Number(point.x)
      const y = Number(point.y)
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return undefined
      path.push({ x, y })
    }
    if (path.length >= 3) {
      const positive = area(path) >= 0 ? path : [...path].reverse()
      paths.push(isHole === true ? [...positive].reverse() : positive)
    }
  }
  const tree = new PolyTree64()
  try {
    booleanOpWithPolyTree(ClipType.Union, paths, null, tree, FillRule.NonZero)
  } catch {
    return undefined
  }
  const result: ForbiddenBoundary[] = []
  return collectForbiddenTree(tree, result) ? result : undefined
}

function collectForbiddenTree(parent: PolyPath64, result: ForbiddenBoundary[]): boolean {
  for (let index = 0; index < parent.count; index += 1) {
    let child: PolyPath64
    try {
      child = parent.child(index)
    } catch {
      return false
    }
    if (child.polygon !== null) {
      result.push({
        points: child.polygon.map(({ x, y }) => ({ x: BigInt(x), y: BigInt(y) })),
        isHole: child.isHole
      })
    }
    if (!collectForbiddenTree(child, result)) return false
  }
  return true
}

function rational(value: bigint): Rational {
  return { numerator: value, denominator: 1n }
}

function makeRational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) return rational(0n)
  const sign = denominator < 0n ? -1n : 1n
  const normalizedNumerator = numerator * sign
  const normalizedDenominator = denominator * sign
  const divisor = greatestCommonDivisor(absBigInt(normalizedNumerator), normalizedDenominator)
  return {
    numerator: normalizedNumerator / divisor,
    denominator: normalizedDenominator / divisor
  }
}

function addRational(first: Rational, second: Rational): Rational {
  return makeRational(
    first.numerator * second.denominator + second.numerator * first.denominator,
    first.denominator * second.denominator
  )
}

function compareRational(first: Rational, second: Rational): number {
  return compareBigInt(first.numerator * second.denominator, second.numerator * first.denominator)
}

function roundRational(value: Rational): bigint {
  const quotient = value.numerator / value.denominator
  const remainder = value.numerator % value.denominator
  if (remainder === 0n) return quotient
  const direction = value.numerator < 0n ? -1n : 1n
  return absBigInt(remainder) * 2n >= value.denominator ? quotient + direction : quotient
}

function canonicalGridAlternatives(value: Rational): ReadonlyArray<bigint> {
  const quotient = value.numerator / value.denominator
  const remainder = value.numerator % value.denominator
  const floor = remainder < 0n ? quotient - 1n : quotient
  const ceil = remainder > 0n ? quotient + 1n : quotient
  return [...new Set([roundRational(value), floor, ceil])].toSorted(compareBigInt)
}

function rationalPointKey(point: RationalPoint): string {
  return `${point.x.numerator}/${point.x.denominator},${point.y.numerator}/${point.y.denominator}`
}

function greatestCommonDivisor(first: bigint, second: bigint): bigint {
  let a = first
  let b = second
  while (b !== 0n) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a === 0n ? 1n : a
}

function canonicalizeBasis(
  first: GridPoint,
  second: GridPoint
): readonly [GridPoint, GridPoint] | undefined {
  const determinant = crossGrid(first, second)
  if (determinant === 0n) return undefined
  const basis: readonly [GridPoint, GridPoint] =
    determinant > 0n ? [first, second] : [second, first]
  return basis
}

/** Exact BigInt certificate proving all farther cells are outside base diameter. */
export function farNeighborCertificate(
  members: ReadonlyArray<IntrinsicPeriodicBaseMember>,
  basis: readonly [GridPoint, GridPoint]
): boolean {
  const vertices = members.flatMap(({ geometry, point }) => {
    const translation = gridPoint(point)
    if (translation === undefined) return []
    return geometry.polygon.points.flatMap((vertex) => {
      const local = gridPoint(vertex)
      return local === undefined ? [] : [{ x: local.x + translation.x, y: local.y + translation.y }]
    })
  })
  if (vertices.length === 0) return false
  let maximumDistanceSquared = 0n
  for (const first of vertices) {
    for (const second of vertices) {
      const dx = first.x - second.x
      const dy = first.y - second.y
      const distance = dx * dx + dy * dy
      if (distance > maximumDistanceSquared) maximumDistanceSquared = distance
    }
  }
  const determinant = absBigInt(crossGrid(basis[0], basis[1]))
  const f2 = basis[0].x ** 2n + basis[0].y ** 2n + basis[1].x ** 2n + basis[1].y ** 2n
  return 4n * determinant * determinant > maximumDistanceSquared * f2
}

function validateLattice(
  members: ReadonlyArray<IntrinsicPeriodicBaseMember>,
  basis: readonly [GridPoint, GridPoint]
): Effect.Effect<
  { readonly sharedBoundaryLengthMm: number } | undefined,
  IrregularGeometryInputError
> {
  return Effect.gen(function* () {
    const placed: IrregularPlacedPiece[] = []
    const center = new Set<number>()
    for (let n = -1; n <= 1; n += 1) {
      for (let m = -1; m <= 1; m += 1) {
        for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
          const member = members[memberIndex]
          if (member === undefined) return undefined
          const point = {
            x: member.point.x + fromGrid(Number(BigInt(n) * basis[0].x + BigInt(m) * basis[1].x)),
            y: member.point.y + fromGrid(Number(BigInt(n) * basis[0].y + BigInt(m) * basis[1].y))
          }
          const candidate = makeCandidate(member.geometry, point)
          const legal = yield* PlacementValidation.checkSheetless({
            placed,
            moving: member.geometry,
            candidate
          })
          if (!legal) return undefined
          if (n === 0 && m === 0) center.add(placed.length)
          placed.push(makePlaced(member.piece, member.geometry, point))
        }
      }
    }
    let sharedBoundaryLengthMm = 0
    const contactedCenter = new Set<number>()
    for (const centerIndex of center) {
      const first = placed[centerIndex]
      if (first === undefined) return undefined
      const firstPolygon = translatePolygonWithBounds(first.collisionGeometry.polygon, {
        x: first.placement.transform.translateX,
        y: first.placement.transform.translateY
      })
      if (firstPolygon === undefined) return undefined
      for (let otherIndex = 0; otherIndex < placed.length; otherIndex += 1) {
        if (center.has(otherIndex)) continue
        const other = placed[otherIndex]
        if (other === undefined) return undefined
        const otherPolygon = translatePolygonWithBounds(other.collisionGeometry.polygon, {
          x: other.placement.transform.translateX,
          y: other.placement.transform.translateY
        })
        if (otherPolygon === undefined) return undefined
        const contact = sharedConvexPolygonBoundaryLength(firstPolygon, otherPolygon)
        if (contact === undefined) return undefined
        if (contact > 0) {
          contactedCenter.add(centerIndex)
          sharedBoundaryLengthMm += contact
        }
      }
    }
    return contactedCenter.size === center.size ? { sharedBoundaryLengthMm } : undefined
  })
}

/** Source-control seam for exact 3x3 legality/contact independently of the far proof. */
export function validatePeriodicContactLatticeControl(
  members: ReadonlyArray<IntrinsicPeriodicBaseMember>,
  v1: IntrinsicPeriodicVector,
  v2: IntrinsicPeriodicVector
): Effect.Effect<boolean, IrregularGeometryInputError> {
  const first = gridPoint(v1)
  const second = gridPoint(v2)
  if (first === undefined || second === undefined) return Effect.succeed(false)
  return validateLattice(members, [first, second]).pipe(
    Effect.map((certificate) => certificate !== undefined)
  )
}

function boundaryCandidatePoints(
  points: ReadonlyArray<IrregularPoint>,
  moving: TransformedCollisionGeometry
): ReadonlyArray<IrregularPoint> {
  const boundaries: ForbiddenBoundary[] = [
    { points: points.map(gridPoint).filter((point): point is GridPoint => point !== undefined) }
  ]
  const xValue = toGridMm(-moving.bounds.minX)
  const yValue = toGridMm(-moving.bounds.minY)
  const x = xValue === undefined ? undefined : BigInt(xValue)
  const y = yValue === undefined ? undefined : BigInt(yValue)
  const candidates = new Map<string, GridPoint>()
  for (const point of boundaries[0]?.points ?? []) candidates.set(`${point.x},${point.y}`, point)
  if (x !== undefined) {
    for (const point of boundaryLineIntersections(boundaries, 'x', x)) {
      const grid = { x: roundRational(point.x), y: roundRational(point.y) }
      candidates.set(`${grid.x},${grid.y}`, grid)
    }
  }
  if (y !== undefined) {
    for (const point of boundaryLineIntersections(boundaries, 'y', y)) {
      const grid = { x: roundRational(point.x), y: roundRational(point.y) }
      candidates.set(`${grid.x},${grid.y}`, grid)
    }
  }
  return [...candidates.values()].toSorted(compareGridPoints).map(fromGridPoint)
}

function combinedBoundsNonnegative(
  geometries: ReadonlyArray<TransformedCollisionGeometry>,
  points: ReadonlyArray<IrregularPoint>
): boolean {
  return geometries.every((geometry, index) => {
    const point = points[index]
    return (
      point !== undefined &&
      geometry.bounds.minX + point.x >= 0 &&
      geometry.bounds.minY + point.y >= 0
    )
  })
}

function makePlaced(
  piece: IrregularPreparedPiece,
  geometry: TransformedCollisionGeometry,
  point: IrregularPoint
): IrregularPlacedPiece {
  return new IrregularPlacedPiece({
    placement: new IrregularPlacement({
      pieceId: piece.pieceId ?? piece.source.id,
      sourcePieceId: piece.source.id,
      placementReference: piece.collisionGeometry.placementReference,
      transform: new IrregularTransform({
        translateX: point.x,
        translateY: point.y,
        rotationDeg: geometry.transform.rotationDeg,
        mirrored: geometry.transform.mirrored
      })
    }),
    collisionGeometry: geometry
  })
}

function geometryForPiece(
  geometry: TransformedCollisionGeometry,
  piece: IrregularPreparedPiece
): TransformedCollisionGeometry {
  return new TransformedCollisionGeometry({
    sourcePieceId: piece.source.id,
    transform: geometry.transform,
    polygon: geometry.polygon,
    bounds: geometry.bounds
  })
}

function makeCandidate(
  geometry: TransformedCollisionGeometry,
  point: IrregularPoint
): IrregularPlacementCandidate {
  return new IrregularPlacementCandidate({
    pieceId: geometry.sourcePieceId,
    transform: geometry.transform,
    point,
    diagnostics: []
  })
}

function anchorPoint(geometry: TransformedCollisionGeometry): IrregularPoint {
  const x = toGridMm(-geometry.bounds.minX)
  const y = toGridMm(-geometry.bounds.minY)
  return { x: fromGrid(x ?? 0), y: fromGrid(y ?? 0) }
}

function canonicalTransformedPolygonKey(geometry: TransformedCollisionGeometry): string {
  const points = geometry.polygon.points.map((point) => gridPoint(point))
  if (points.some((point) => point === undefined)) return 'invalid'
  const valid = points.filter((point): point is GridPoint => point !== undefined)
  const minX = valid.reduce((minimum, { x }) => (x < minimum ? x : minimum), valid[0]?.x ?? 0n)
  const minY = valid.reduce((minimum, { y }) => (y < minimum ? y : minimum), valid[0]?.y ?? 0n)
  return canonicalCycle(valid.map(({ x, y }) => ({ x: x - minX, y: y - minY })))
}

function canonicalCellKey(
  role: 'P1' | 'P2',
  members: ReadonlyArray<IntrinsicPeriodicBaseMember>,
  basis: readonly [GridPoint, GridPoint]
): string {
  const worldPolygons = members.map(({ geometry, point }) => {
    const translation = gridPoint(point)
    if (translation === undefined) return []
    return geometry.polygon.points.flatMap((vertex) => {
      const local = gridPoint(vertex)
      return local === undefined ? [] : [{ x: local.x + translation.x, y: local.y + translation.y }]
    })
  })
  const variants: string[] = []
  for (let turn = 0; turn < 4; turn += 1) {
    const rotate = (point: GridPoint): GridPoint => {
      switch (turn) {
        case 1:
          return { x: -point.y, y: point.x }
        case 2:
          return { x: -point.x, y: -point.y }
        case 3:
          return { x: point.y, y: -point.x }
        default:
          return point
      }
    }
    const first = rotate(basis[0])
    const second = rotate(basis[1])
    const rotatedPolygons = worldPolygons.map((polygon) => polygon.map(rotate))
    const all = rotatedPolygons.flat()
    const minX = all.reduce(
      (minimum, point) => (point.x < minimum ? point.x : minimum),
      all[0]?.x ?? 0n
    )
    const minY = all.reduce(
      (minimum, point) => (point.y < minimum ? point.y : minimum),
      all[0]?.y ?? 0n
    )
    const memberKey = rotatedPolygons
      .map((polygon) => canonicalCycle(polygon.map(({ x, y }) => ({ x: x - minX, y: y - minY }))))
      .toSorted()
      .join('|')
    variants.push(`${memberKey}:${first.x},${first.y};${second.x},${second.y}`)
    variants.push(`${memberKey}:${second.x},${second.y};${first.x},${first.y}`)
  }
  return `${role}:${variants.toSorted()[0]}`
}

/** Source-control seam for whole-cell quarter-turn and basis-swap identity. */
export function canonicalPeriodicCellIdentityControl(
  role: 'P1' | 'P2',
  members: ReadonlyArray<IntrinsicPeriodicBaseMember>,
  v1: IntrinsicPeriodicVector,
  v2: IntrinsicPeriodicVector
): string | undefined {
  const first = gridPoint(v1)
  const second = gridPoint(v2)
  return first === undefined || second === undefined
    ? undefined
    : canonicalCellKey(role, members, [first, second])
}

function canonicalCycle(points: ReadonlyArray<GridPoint>): string {
  const variants = [points, [...points].reverse()].flatMap((sequence) =>
    sequence.map((_, offset) =>
      [...sequence.slice(offset), ...sequence.slice(0, offset)]
        .map(({ x, y }) => `${x},${y}`)
        .join(';')
    )
  )
  return variants.toSorted()[0] ?? ''
}

function polygonAreaGrid2(geometry: TransformedCollisionGeometry, point: IrregularPoint): bigint {
  const translated = geometry.polygon.points.map(({ x, y }) => ({ x: x + point.x, y: y + point.y }))
  let doubled = 0n
  for (let index = 0; index < translated.length; index += 1) {
    const first = gridPoint(translated[index] ?? { x: 0, y: 0 })
    const second = gridPoint(translated[(index + 1) % translated.length] ?? { x: 0, y: 0 })
    if (first === undefined || second === undefined) return 0n
    doubled += first.x * second.y - second.x * first.y
  }
  return absBigInt(doubled)
}

/** Source-control seam preserving odd doubled grid areas without truncation. */
export function periodicMemberDoubledAreaControl(member: IntrinsicPeriodicBaseMember): string {
  return polygonAreaGrid2(member.geometry, member.point).toString()
}

function measureBaseCellShape(
  members: ReadonlyArray<IntrinsicPeriodicBaseMember>
): { readonly maximumSideMm: number; readonly hullWasteRatio: number } | undefined {
  const points = members.flatMap(({ geometry, point }) =>
    geometry.polygon.points.map(({ x, y }) => ({ x: x + point.x, y: y + point.y }))
  )
  const bounds = boundsForPoints(points)
  if (bounds === undefined) return undefined
  const hull = convexHullGrid(
    points.flatMap((point) => {
      const grid = gridPoint(point)
      return grid === undefined ? [] : [grid]
    })
  )
  if (hull.length < 3) return undefined
  const hullDoubledAreaGrid2 = polygonGridArea(hull)
  const memberDoubledAreaGrid2 = members.reduce(
    (sum, member) => sum + polygonAreaGrid2(member.geometry, member.point),
    0n
  )
  if (hullDoubledAreaGrid2 <= 0n || memberDoubledAreaGrid2 > hullDoubledAreaGrid2) return undefined
  return {
    maximumSideMm: Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY),
    hullWasteRatio:
      Number(hullDoubledAreaGrid2 - memberDoubledAreaGrid2) / Number(hullDoubledAreaGrid2)
  }
}

function convexHullGrid(points: ReadonlyArray<GridPoint>): ReadonlyArray<GridPoint> {
  const unique = [
    ...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values()
  ].toSorted(compareGridPoints)
  if (unique.length <= 1) return unique
  const lower: GridPoint[] = []
  for (const point of unique) {
    while (lower.length >= 2 && orientationCross(lower.at(-2), lower.at(-1), point) <= 0n)
      lower.pop()
    lower.push(point)
  }
  const upper: GridPoint[] = []
  for (const point of [...unique].reverse()) {
    while (upper.length >= 2 && orientationCross(upper.at(-2), upper.at(-1), point) <= 0n)
      upper.pop()
    upper.push(point)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

function orientationCross(
  origin: GridPoint | undefined,
  first: GridPoint | undefined,
  second: GridPoint
): bigint {
  if (origin === undefined || first === undefined) return 0n
  return (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x)
}

function polygonGridArea(points: ReadonlyArray<GridPoint>): bigint {
  let doubled = 0n
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index]
    const second = points[(index + 1) % points.length]
    if (first === undefined || second === undefined) return 0n
    doubled += first.x * second.y - second.x * first.y
  }
  return absBigInt(doubled)
}

function compareCells(first: IntrinsicPeriodicCell, second: IntrinsicPeriodicCell): number {
  const densityOrder = compareBigInt(
    BigInt(second.memberDoubledAreaGrid2) * BigInt(first.determinantGrid2),
    BigInt(first.memberDoubledAreaGrid2) * BigInt(second.determinantGrid2)
  )
  return (
    densityOrder ||
    first.envelopeMaximumSideMm - second.envelopeMaximumSideMm ||
    first.hullWasteRatio - second.hullWasteRatio ||
    second.sharedBoundaryLengthMm - first.sharedBoundaryLengthMm ||
    first.canonicalKey.localeCompare(second.canonicalKey)
  )
}

/** Exact-density periodic-cell archive order. */
export function rankIntrinsicPeriodicCells(
  cells: ReadonlyArray<IntrinsicPeriodicCell>
): ReadonlyArray<IntrinsicPeriodicCell> {
  return cells.toSorted(compareCells)
}

function gridPoint(point: IrregularPoint): GridPoint | undefined {
  const x = toGridMm(point.x)
  const y = toGridMm(point.y)
  return x === undefined || y === undefined ? undefined : { x: BigInt(x), y: BigInt(y) }
}

function fromGridPoint(point: GridPoint): IrregularPoint {
  return { x: fromGrid(Number(point.x)), y: fromGrid(Number(point.y)) }
}

function compareGridPoints(first: GridPoint, second: GridPoint): number {
  return compareBigInt(first.x, second.x) || compareBigInt(first.y, second.y)
}

function crossGrid(first: GridPoint, second: GridPoint): bigint {
  return first.x * second.y - first.y * second.x
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value
}

function compareBigInt(first: bigint, second: bigint): number {
  return first < second ? -1 : first > second ? 1 : 0
}
