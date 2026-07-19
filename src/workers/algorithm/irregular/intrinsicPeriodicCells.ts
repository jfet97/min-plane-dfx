import { Effect, Order } from 'effect'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPreparedPiece,
  type IrregularNestingSettings,
  IrregularTransform,
  type IrregularPoint,
  type IrregularTransformCandidate,
  type TransformedCollisionGeometry
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
import { groupIntrinsicCollisionFamilies } from './intrinsicStrictFamilyPortfolio.js'

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
  readonly determinantGrid2: number
  readonly density: number
  readonly sharedBoundaryLengthMm: number
  readonly canonicalKey: string
}

export interface IntrinsicPeriodicCatalog {
  readonly selectedFamilyKey: string | undefined
  readonly uniqueTransformCount: number
  readonly enumeratedPairCount: number
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
  readonly x: number
  readonly y: number
}

interface ForbiddenBoundary {
  readonly points: ReadonlyArray<GridPoint>
}

/** Enumerates the bounded exact one- and two-transform periodic cell catalog. */
export function enumerateIntrinsicPeriodicCells(
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  maximumRuntimeMs = 5_000
): Effect.Effect<
  IntrinsicPeriodicCatalog,
  IrregularNestingNotImplementedError | IrregularGeometryInputError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const geometryKernel = yield* GeometryKernel
    const nfp = yield* NfpIfpService
    const settings = yield* GeometrySettings
    const family = groupIntrinsicCollisionFamilies(pieces)
      .filter(({ members }) => members.length >= 2)
      .toSorted(
        (first, second) =>
          second.members.length * second.collisionAreaMm2 -
            first.members.length * first.collisionAreaMm2 ||
          second.members.length - first.members.length ||
          first.key.localeCompare(second.key)
      )[0]
    if (family === undefined) {
      return {
        selectedFamilyKey: undefined,
        uniqueTransformCount: 0,
        enumeratedPairCount: 0,
        cells: [],
        rejected: {}
      }
    }
    const representative = family.members[0]
    if (representative === undefined) {
      return {
        selectedFamilyKey: family.key,
        uniqueTransformCount: 0,
        enumeratedPairCount: 0,
        cells: [],
        rejected: { missingRepresentative: 1 }
      }
    }
    const transformed: TransformedCollisionGeometry[] = []
    const transformKeys = new Set<string>()
    for (const transform of [...representative.transforms].sort(transformOrder)) {
      if (performance.now() - startedAt >= maximumRuntimeMs) break
      const geometry = yield* geometryKernel.transformCollisionGeometry({
        geometry: representative.collisionGeometry,
        transform
      })
      const key = canonicalTransformedPolygonKey(geometry)
      if (!transformKeys.has(key)) {
        transformKeys.add(key)
        transformed.push(geometry)
      }
      if (transformed.length >= 8) break
    }

    const rejected = new Map<string, number>()
    const cells: IntrinsicPeriodicCell[] = []
    const cellKeys = new Set<string>()
    const addCell = (cell: IntrinsicPeriodicCell | undefined, reason: string) => {
      if (cell === undefined) {
        rejected.set(reason, (rejected.get(reason) ?? 0) + 1)
      } else if (!cellKeys.has(cell.canonicalKey)) {
        cellKeys.add(cell.canonicalKey)
        cells.push(cell)
      }
    }

    for (const geometry of transformed) {
      if (performance.now() - startedAt >= maximumRuntimeMs) break
      const point = anchorPoint(geometry)
      const members = [{ piece: representative, geometry, point }]
      const derived = yield* deriveCells({
        role: 'P1',
        familyKey: family.key,
        members,
        nfp,
        settings
      })
      for (const cell of derived) addCell(cell, 'invalidP1Cell')
      if (derived.length === 0) addCell(undefined, 'noP1Basis')
    }

    let enumeratedPairCount = 0
    for (let firstIndex = 0; firstIndex < transformed.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < transformed.length; secondIndex += 1) {
        if (enumeratedPairCount >= 28 || performance.now() - startedAt >= maximumRuntimeMs) break
        enumeratedPairCount += 1
        const first = transformed[firstIndex]
        const second = transformed[secondIndex]
        if (first === undefined || second === undefined) continue
        const firstPoint = anchorPoint(first)
        const fixed = makePlaced(representative, first, firstPoint)
        const pairNfp = yield* nfp.computeNfp({
          fixed,
          moving: second,
          settings: settings.geometry
        })
        const offsets = boundaryCandidatePoints(pairNfp.boundary.points, second)
        for (const point of offsets) {
          if (performance.now() - startedAt >= maximumRuntimeMs) break
          const legal = yield* PlacementValidation.checkSheetless({
            placed: [fixed],
            moving: second,
            candidate: makeCandidate(second, point)
          })
          if (!legal || !combinedBoundsNonnegative([first, second], [firstPoint, point])) continue
          const members = [
            { piece: representative, geometry: first, point: firstPoint },
            { piece: family.members[1] ?? representative, geometry: second, point }
          ]
          const derived = yield* deriveCells({
            role: 'P2',
            familyKey: family.key,
            members,
            nfp,
            settings
          })
          for (const cell of derived) addCell(cell, 'invalidP2Cell')
        }
      }
    }
    return {
      selectedFamilyKey: family.key,
      uniqueTransformCount: transformed.length,
      enumeratedPairCount,
      cells: cells.toSorted(compareCells),
      rejected: Object.fromEntries([...rejected.entries()].toSorted())
    }
  })
}

/** Expands one certified cell into every bounded finite crop and keeps its best topology. */
export function expandIntrinsicPeriodicCell(
  cell: IntrinsicPeriodicCell,
  familyMembers: ReadonlyArray<IrregularPreparedPiece>
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
              const candidate = makeCandidate(base.geometry, point)
              if (
                !(yield* PlacementValidation.checkSheetless({
                  placed,
                  moving: base.geometry,
                  candidate
                }))
              ) {
                legal = false
                break
              }
              placed.push(makePlaced(piece, base.geometry, point))
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
    return candidates.toSorted(compareSeeds).slice(0, 1)
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

function deriveCells(input: {
  readonly role: 'P1' | 'P2'
  readonly familyKey: string
  readonly members: ReadonlyArray<IntrinsicPeriodicBaseMember>
  readonly nfp: NfpIfpService
  readonly settings: IrregularNestingSettings
}): Effect.Effect<
  ReadonlyArray<IntrinsicPeriodicCell>,
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
        if (movingGrid === undefined) return []
        const points = boundary.boundary.points
          .map(gridPoint)
          .filter((point): point is GridPoint => point !== undefined)
          .map((point) => ({ x: point.x - movingGrid.x, y: point.y - movingGrid.y }))
        if (points.length !== boundary.boundary.points.length) return []
        forbidden.push({ points })
      }
    }
    const bases = [deriveAxisBasis(forbidden, false), deriveAxisBasis(forbidden, true)].filter(
      (basis): basis is readonly [GridPoint, GridPoint] => basis !== undefined
    )
    const result: IntrinsicPeriodicCell[] = []
    for (const [rawV1, rawV2] of bases) {
      const canonical = canonicalizeBasis(rawV1, rawV2)
      if (canonical === undefined || !farNeighborCertificate(input.members, canonical)) continue
      const certificate = yield* validateLattice(input.members, canonical)
      if (certificate === undefined) continue
      const determinantGrid2 = Math.abs(crossGrid(canonical[0], canonical[1]))
      const memberAreaGrid2 = input.members.reduce(
        (sum, member) => sum + polygonAreaGrid2(member.geometry, member.point),
        0
      )
      const canonicalKey = canonicalCellKey(input.role, input.members, canonical)
      result.push({
        role: input.role,
        familyKey: input.familyKey,
        members: input.members,
        v1: fromGridPoint(canonical[0]),
        v2: fromGridPoint(canonical[1]),
        determinantGrid2,
        density: memberAreaGrid2 / determinantGrid2,
        sharedBoundaryLengthMm: certificate.sharedBoundaryLengthMm,
        canonicalKey
      })
    }
    return result
  })
}

function deriveAxisBasis(
  boundaries: ReadonlyArray<ForbiddenBoundary>,
  swapAxes: boolean
): readonly [GridPoint, GridPoint] | undefined {
  const oriented = boundaries.map(({ points }) => ({
    points: points.map((point) => (swapAxes ? { x: point.y, y: point.x } : point))
  }))
  const axis = boundaryLineIntersections(oriented, 'y', 0)
    .filter(({ x }) => x > 0)
    .toSorted(compareGridPoints)[0]
  if (axis === undefined) return undefined
  const shifted = [
    ...oriented,
    ...oriented.map(({ points }) => ({
      points: points.map((point) => ({ x: point.x + axis.x, y: point.y }))
    }))
  ]
  const constrained = [
    ...shifted.flatMap(({ points }) => points),
    ...boundaryLineIntersections(shifted, 'x', 0),
    ...boundaryLineIntersections(shifted, 'x', axis.x - 1)
  ]
    .filter(({ x, y }) => y > 0 && x >= 0 && x < axis.x)
    .toSorted((first, second) => first.y - second.y || first.x - second.x)
  const second = constrained[0]
  if (second === undefined) return undefined
  const unswap = (point: GridPoint): GridPoint => (swapAxes ? { x: point.y, y: point.x } : point)
  return [unswap(axis), unswap(second)]
}

function boundaryLineIntersections(
  boundaries: ReadonlyArray<ForbiddenBoundary>,
  axis: 'x' | 'y',
  value: number
): ReadonlyArray<GridPoint> {
  const result = new Map<string, GridPoint>()
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
          result.set(`${first.x},${first.y}`, first)
          result.set(`${second.x},${second.y}`, second)
        }
        continue
      }
      const numerator = value - firstValue
      const denominator = secondValue - firstValue
      const otherAxis = axis === 'x' ? 'y' : 'x'
      const other =
        first[otherAxis] + ((second[otherAxis] - first[otherAxis]) * numerator) / denominator
      if (!Number.isInteger(other)) continue
      const point = axis === 'x' ? { x: value, y: other } : { x: other, y: value }
      result.set(`${point.x},${point.y}`, point)
    }
  }
  return [...result.values()]
}

function canonicalizeBasis(
  first: GridPoint,
  second: GridPoint
): readonly [GridPoint, GridPoint] | undefined {
  const determinant = crossGrid(first, second)
  if (determinant === 0) return undefined
  const basis: readonly [GridPoint, GridPoint] = determinant > 0 ? [first, second] : [second, first]
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
      const dx = BigInt(first.x - second.x)
      const dy = BigInt(first.y - second.y)
      const distance = dx * dx + dy * dy
      if (distance > maximumDistanceSquared) maximumDistanceSquared = distance
    }
  }
  const determinant = BigInt(Math.abs(crossGrid(basis[0], basis[1])))
  const f2 = BigInt(basis[0].x ** 2 + basis[0].y ** 2 + basis[1].x ** 2 + basis[1].y ** 2)
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
            x: member.point.x + fromGrid(n * basis[0].x + m * basis[1].x),
            y: member.point.y + fromGrid(n * basis[0].y + m * basis[1].y)
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

function boundaryCandidatePoints(
  points: ReadonlyArray<IrregularPoint>,
  moving: TransformedCollisionGeometry
): ReadonlyArray<IrregularPoint> {
  const boundaries: ForbiddenBoundary[] = [
    { points: points.map(gridPoint).filter((point): point is GridPoint => point !== undefined) }
  ]
  const x = toGridMm(-moving.bounds.minX)
  const y = toGridMm(-moving.bounds.minY)
  const candidates = new Map<string, GridPoint>()
  for (const point of boundaries[0]?.points ?? []) candidates.set(`${point.x},${point.y}`, point)
  if (x !== undefined) {
    for (const point of boundaryLineIntersections(boundaries, 'x', x)) {
      candidates.set(`${point.x},${point.y}`, point)
    }
  }
  if (y !== undefined) {
    for (const point of boundaryLineIntersections(boundaries, 'y', y)) {
      candidates.set(`${point.x},${point.y}`, point)
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
  const minX = Math.min(...valid.map(({ x }) => x))
  const minY = Math.min(...valid.map(({ y }) => y))
  return canonicalCycle(valid.map(({ x, y }) => ({ x: x - minX, y: y - minY })))
}

function canonicalCellKey(
  role: 'P1' | 'P2',
  members: ReadonlyArray<IntrinsicPeriodicBaseMember>,
  basis: readonly [GridPoint, GridPoint]
): string {
  const memberKey = members
    .map(
      ({ geometry, point }) => `${canonicalTransformedPolygonKey(geometry)}@${point.x},${point.y}`
    )
    .toSorted()
    .join('|')
  const basisVariants: string[] = []
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
    basisVariants.push(`${first.x},${first.y};${second.x},${second.y}`)
    basisVariants.push(`${second.x},${second.y};${first.x},${first.y}`)
  }
  return `${role}:${memberKey}:${basisVariants.toSorted()[0]}`
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

function polygonAreaGrid2(geometry: TransformedCollisionGeometry, point: IrregularPoint): number {
  const translated = geometry.polygon.points.map(({ x, y }) => ({ x: x + point.x, y: y + point.y }))
  let doubled = 0
  for (let index = 0; index < translated.length; index += 1) {
    const first = gridPoint(translated[index] ?? { x: 0, y: 0 })
    const second = gridPoint(translated[(index + 1) % translated.length] ?? { x: 0, y: 0 })
    if (first === undefined || second === undefined) return 0
    doubled += first.x * second.y - second.x * first.y
  }
  return Math.abs(doubled) / 2
}

function compareCells(first: IntrinsicPeriodicCell, second: IntrinsicPeriodicCell): number {
  return (
    second.density - first.density ||
    Math.max(vectorLength(first.v1), vectorLength(first.v2)) -
      Math.max(vectorLength(second.v1), vectorLength(second.v2)) ||
    second.sharedBoundaryLengthMm - first.sharedBoundaryLengthMm ||
    first.canonicalKey.localeCompare(second.canonicalKey)
  )
}

function vectorLength(vector: IntrinsicPeriodicVector): number {
  return Math.hypot(vector.x, vector.y)
}

function gridPoint(point: IrregularPoint): GridPoint | undefined {
  const x = toGridMm(point.x)
  const y = toGridMm(point.y)
  return x === undefined || y === undefined ? undefined : { x, y }
}

function fromGridPoint(point: GridPoint): IrregularPoint {
  return { x: fromGrid(point.x), y: fromGrid(point.y) }
}

function compareGridPoints(first: GridPoint, second: GridPoint): number {
  return first.x - second.x || first.y - second.y
}

function crossGrid(first: GridPoint, second: GridPoint): number {
  return first.x * second.y - first.y * second.x
}
