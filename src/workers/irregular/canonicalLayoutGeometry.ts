import {
  area,
  booleanOpWithPolyTree,
  ClipType,
  FillRule,
  type Path64,
  type PolyPath64,
  polyTreeToPaths64,
  PolyTree64
} from 'clipper2-ts'
import type { SheetSpec } from '@shared/domain/nesting.js'
import type { PieceId } from '@shared/domain/ids.js'
import type { IrregularPlacedPiece } from '@shared/irregular/domain.js'
import { measureSharedConvexPolygonBoundaryContact } from './convexPolygonContact.js'
import { fromGrid, toGridMm } from './clipper2OffsetPolicy.js'
import { boundsForPoints } from './convexBounds.js'
import type { InternalPoint, InternalPolygonWithBounds } from './internalGeometry.js'

export interface CanonicalLayoutTopology {
  readonly enclosedCavityCount: number
  readonly largestOccupiedHullGapRatio: number
  readonly occupiedEnvelopeAspectRatio: number
  readonly positiveContactComponentCount: number
  readonly isolatedPieceCount: number
  readonly largestPositiveContactComponentSize: number
  readonly largestPositiveContactComponentRatio: number
}

interface CanonicalPlacedPolygon {
  readonly pieceId: PieceId
  readonly path: Path64
  readonly contactPolygon: InternalPolygonWithBounds
}

export interface CanonicalGridAabb {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

export interface CanonicalLayoutStructuralAnalysis {
  readonly pieces: ReadonlyArray<{
    readonly pieceId: PieceId
    readonly aabb: CanonicalGridAabb
    readonly areaGrid2: number
  }>
  readonly positiveContactComponents: ReadonlyArray<ReadonlyArray<PieceId>>
  readonly positiveContactPairs: ReadonlyArray<readonly [PieceId, PieceId]>
  readonly largestHullGap:
    | {
        readonly path: ReadonlyArray<InternalPoint>
        readonly areaMm2: number
        readonly aabb: CanonicalGridAabb
      }
    | undefined
  readonly positiveAreaConflicts: ReadonlyArray<readonly [PieceId, PieceId]>
  readonly positiveAreaConflictMeasurements: ReadonlyArray<{
    readonly pair: readonly [PieceId, PieceId]
    readonly areaMm2: number
  }>
  readonly wallOffenders: ReadonlyArray<PieceId>
}

type QuarterTurn = 0 | 90 | 180 | 270

/** Production collision-layout identity on the 0.001 mm grid. */
export function canonicalCollisionLayoutIdentity(
  placed: ReadonlyArray<IrregularPlacedPiece>
): string | undefined {
  const polygons = canonicalPlacedPolygons(placed)
  if (polygons === undefined) return undefined
  const identities = ([0, 90, 180, 270] as const).map((rotationDeg) =>
    identityAtQuarterTurn(polygons.map(({ path }) => path), rotationDeg)
  )
  return identities.some((identity) => identity === undefined)
    ? undefined
    : identities.filter((identity): identity is string => identity !== undefined).toSorted()[0]
}

/** Sheet-free cavity and positive-contact topology from canonical collision polygons. */
export function measureCanonicalLayoutTopology(
  placed: ReadonlyArray<IrregularPlacedPiece>
): CanonicalLayoutTopology | undefined {
  const polygons = canonicalPlacedPolygons(placed)
  if (polygons === undefined) return undefined
  const hull = convexHull(polygons.flatMap(({ path }) => path.map(({ x, y }) => ({ x, y }))))
  const hullArea = Math.abs(signedArea(hull))
  if (!Number.isFinite(hullArea)) return undefined
  const largestGapArea = largestHullGapArea(hull, polygons.map(({ path }) => path))
  const enclosedCavityCount = countEnclosedOccupiedCavities(polygons.map(({ path }) => path))
  const occupiedEnvelopeAspectRatio = envelopeAspectRatio(polygons.map(({ path }) => path))
  const graph = measureContactGraph(polygons.map(({ contactPolygon }) => contactPolygon))
  if (
    largestGapArea === undefined ||
    enclosedCavityCount === undefined ||
    occupiedEnvelopeAspectRatio === undefined ||
    graph === undefined
  ) {
    return undefined
  }
  const largestOccupiedHullGapRatio = hullArea === 0 ? 0 : largestGapArea / hullArea
  return Number.isFinite(largestOccupiedHullGapRatio)
    ? {
        enclosedCavityCount,
        largestOccupiedHullGapRatio,
        occupiedEnvelopeAspectRatio,
        ...graph,
        largestPositiveContactComponentRatio:
          polygons.length === 0 ? 0 : graph.largestPositiveContactComponentSize / polygons.length
      }
    : undefined
}

/** True only when every canonical-grid polygon fits and no pair has positive overlap. */
export function assertCanonicalGridLegalLayout(
  sheet: SheetSpec,
  placed: ReadonlyArray<IrregularPlacedPiece>
): boolean {
  const polygons = canonicalPlacedPolygons(placed)
  if (polygons === undefined) return false
  const sheetWidth = toGridMm(sheet.width)
  const sheetHeight = toGridMm(sheet.height)
  if (sheetWidth === undefined || sheetHeight === undefined) return false
  for (const { path } of polygons) {
    if (path.some(({ x, y }) => x < 0 || y < 0 || x > sheetWidth || y > sheetHeight)) {
      return false
    }
  }
  for (let firstIndex = 0; firstIndex < polygons.length; firstIndex += 1) {
    const first = polygons[firstIndex]
    if (first === undefined) return false
    for (let secondIndex = 0; secondIndex < firstIndex; secondIndex += 1) {
      const second = polygons[secondIndex]
      if (second === undefined) return false
      const intersection = new PolyTree64()
      try {
        booleanOpWithPolyTree(
          ClipType.Intersection,
          [first.path],
          [second.path],
          intersection,
          FillRule.NonZero
        )
      } catch {
        return false
      }
      if (polyTreeToPaths64(intersection).some((path) => Math.abs(area(path)) > 0)) return false
    }
  }
  return true
}

/** Exact canonical-grid structural facts without target or acceptance policy. */
export function analyzeCanonicalLayoutStructure(
  sheet: SheetSpec,
  placed: ReadonlyArray<IrregularPlacedPiece>
): CanonicalLayoutStructuralAnalysis | undefined {
  const polygons = canonicalPlacedPolygons(placed)
  const sheetWidth = toGridMm(sheet.width)
  const sheetHeight = toGridMm(sheet.height)
  if (polygons === undefined || sheetWidth === undefined || sheetHeight === undefined) {
    return undefined
  }
  const uniqueIds = new Set(polygons.map(({ pieceId }) => pieceId))
  if (uniqueIds.size !== polygons.length) return undefined
  const neighbors = polygons.map(() => new Set<number>())
  const positiveContactPairs: Array<readonly [PieceId, PieceId]> = []
  const positiveAreaConflicts: Array<readonly [PieceId, PieceId]> = []
  const positiveAreaConflictMeasurements: Array<{
    readonly pair: readonly [PieceId, PieceId]
    readonly areaMm2: number
  }> = []
  for (let firstIndex = 0; firstIndex < polygons.length; firstIndex += 1) {
    const first = polygons[firstIndex]
    if (first === undefined) return undefined
    for (let secondIndex = 0; secondIndex < firstIndex; secondIndex += 1) {
      const second = polygons[secondIndex]
      if (second === undefined) return undefined
      const contact = measureSharedConvexPolygonBoundaryContact(
        first.contactPolygon,
        second.contactPolygon
      )
      if (contact === undefined) return undefined
      if (contact.lengthMm > 0) {
        neighbors[firstIndex]?.add(secondIndex)
        neighbors[secondIndex]?.add(firstIndex)
        positiveContactPairs.push(orderedPiecePair(first.pieceId, second.pieceId))
      }
      const intersection = new PolyTree64()
      try {
        booleanOpWithPolyTree(
          ClipType.Intersection,
          [first.path],
          [second.path],
          intersection,
          FillRule.NonZero
        )
      } catch {
        return undefined
      }
      const intersectionAreaGrid2 = polyTreeToPaths64(intersection).reduce(
        (sum, path) => sum + Math.abs(area(path)),
        0
      )
      if (intersectionAreaGrid2 > 0) {
        const pair = orderedPiecePair(first.pieceId, second.pieceId)
        positiveAreaConflicts.push(pair)
        positiveAreaConflictMeasurements.push({
          pair,
          areaMm2: intersectionAreaGrid2 / 1_000_000
        })
      }
    }
  }
  const positiveContactComponents = contactComponents(polygons, neighbors)
  if (positiveContactComponents === undefined) return undefined
  const hull = convexHull(polygons.flatMap(({ path }) => path))
  const largestHullGap = largestHullGapRegion(hull, polygons.map(({ path }) => path))
  if (largestHullGap === null) return undefined
  const pieces = polygons.map(({ pieceId, path }) => {
    const aabb = gridPathAabb(path)
    return aabb === undefined ? undefined : { pieceId, aabb, areaGrid2: Math.abs(area(path)) }
  })
  if (pieces.some((piece) => piece === undefined)) return undefined
  const wallOffenders = polygons
    .filter(({ path }) =>
      path.some(({ x, y }) => x < 0 || y < 0 || x > sheetWidth || y > sheetHeight)
    )
    .map(({ pieceId }) => pieceId)
    .toSorted()
  return {
    pieces: pieces.filter(
      (piece): piece is {
        readonly pieceId: PieceId
        readonly aabb: CanonicalGridAabb
        readonly areaGrid2: number
      } =>
        piece !== undefined
    ),
    positiveContactComponents,
    positiveContactPairs: positiveContactPairs.toSorted(comparePiecePairs),
    largestHullGap: largestHullGap ?? undefined,
    positiveAreaConflicts: positiveAreaConflicts.toSorted(comparePiecePairs),
    positiveAreaConflictMeasurements: positiveAreaConflictMeasurements.toSorted((first, second) =>
      comparePiecePairs(first.pair, second.pair)
    ),
    wallOffenders
  }
}

function canonicalPlacedPolygons(
  placed: ReadonlyArray<IrregularPlacedPiece>
): ReadonlyArray<CanonicalPlacedPolygon> | undefined {
  const result: CanonicalPlacedPolygon[] = []
  for (const entry of placed) {
    const path: Path64 = []
    const points: InternalPoint[] = []
    const { translateX, translateY } = entry.placement.transform
    for (const point of entry.collisionGeometry.polygon.points) {
      const x = toGridMm(point.x + translateX)
      const y = toGridMm(point.y + translateY)
      if (x === undefined || y === undefined) return undefined
      path.push({ x, y })
      points.push({ x: fromGrid(x), y: fromGrid(y) })
    }
    if (path.length < 3 || signedArea(path) === 0) return undefined
    const bounds = boundsForPoints(points)
    if (bounds === undefined) return undefined
    result.push({
      pieceId: entry.placement.pieceId ?? entry.placement.sourcePieceId,
      path,
      contactPolygon: { polygon: { points }, bounds }
    })
  }
  return result
}

function orderedPiecePair(first: PieceId, second: PieceId): readonly [PieceId, PieceId] {
  return first < second ? [first, second] : [second, first]
}

function comparePiecePairs(
  first: readonly [PieceId, PieceId],
  second: readonly [PieceId, PieceId]
): number {
  return first[0].localeCompare(second[0]) || first[1].localeCompare(second[1])
}

function contactComponents(
  polygons: ReadonlyArray<CanonicalPlacedPolygon>,
  neighbors: ReadonlyArray<ReadonlySet<number>>
): ReadonlyArray<ReadonlyArray<PieceId>> | undefined {
  const visited = new Set<number>()
  const components: PieceId[][] = []
  for (let start = 0; start < polygons.length; start += 1) {
    if (visited.has(start)) continue
    const pending = [start]
    const component: PieceId[] = []
    visited.add(start)
    while (pending.length > 0) {
      const current = pending.pop()
      if (current === undefined) continue
      const polygon = polygons[current]
      if (polygon === undefined) return undefined
      component.push(polygon.pieceId)
      for (const neighbor of neighbors[current] ?? []) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        pending.push(neighbor)
      }
    }
    components.push(component.toSorted())
  }
  const areaById = new Map(
    polygons.map(({ pieceId, path }) => [pieceId, Math.abs(area(path))] as const)
  )
  return components.toSorted((first, second) => {
    const firstArea = first.reduce((sum, pieceId) => sum + (areaById.get(pieceId) ?? 0), 0)
    const secondArea = second.reduce((sum, pieceId) => sum + (areaById.get(pieceId) ?? 0), 0)
    return (
      second.length - first.length ||
      secondArea - firstArea ||
      first.join('|').localeCompare(second.join('|'))
    )
  })
}

function gridPathAabb(path: Path64): CanonicalGridAabb | undefined {
  const first = path[0]
  if (first === undefined) return undefined
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
  return { minX, minY, maxX, maxY }
}

function identityAtQuarterTurn(
  paths: ReadonlyArray<Path64>,
  rotationDeg: QuarterTurn
): string | undefined {
  const rotated = paths.map((path) => path.map((point) => rotateGridPoint(point, rotationDeg)))
  const points = rotated.flat()
  const first = points[0]
  if (first === undefined) return '[]'
  let minX = first.x
  let minY = first.y
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
  }
  return JSON.stringify(
    rotated
      .map((path) => canonicalRing(path.map(({ x, y }) => ({ x: x - minX, y: y - minY }))))
      .toSorted()
  )
}

function canonicalRing(path: Path64): string {
  const forward = canonicalRingDirection(path)
  const reverse = canonicalRingDirection([...path].reverse())
  return forward < reverse ? forward : reverse
}

function canonicalRingDirection(path: Path64): string {
  if (path.length === 0) return ''
  let best: string | undefined
  for (let offset = 0; offset < path.length; offset += 1) {
    const key = path
      .map((_, index) => path[(index + offset) % path.length])
      .map((point) => `${point?.x},${point?.y}`)
      .join(';')
    if (best === undefined || key < best) best = key
  }
  return best ?? ''
}

function rotateGridPoint(point: { readonly x: number; readonly y: number }, rotationDeg: QuarterTurn) {
  switch (rotationDeg) {
    case 0:
      return point
    case 90:
      return { x: -point.y, y: point.x }
    case 180:
      return { x: -point.x, y: -point.y }
    case 270:
      return { x: point.y, y: -point.x }
  }
}

function largestHullGapArea(hull: Path64, occupied: ReadonlyArray<Path64>): number | undefined {
  if (hull.length < 3) return 0
  const occupiedTree = new PolyTree64()
  const gapTree = new PolyTree64()
  try {
    booleanOpWithPolyTree(ClipType.Union, [...occupied], null, occupiedTree, FillRule.EvenOdd)
    booleanOpWithPolyTree(
      ClipType.Difference,
      [counterClockwise(hull)],
      polyTreeToPaths64(occupiedTree),
      gapTree,
      FillRule.NonZero
    )
  } catch {
    return undefined
  }
  return largestNetRegionArea(gapTree)
}

function largestHullGapRegion(
  hull: Path64,
  occupied: ReadonlyArray<Path64>
):
  | {
      readonly path: ReadonlyArray<InternalPoint>
      readonly areaMm2: number
      readonly aabb: CanonicalGridAabb
    }
  | undefined
  | null {
  if (hull.length < 3) return undefined
  const occupiedTree = new PolyTree64()
  const gapTree = new PolyTree64()
  try {
    booleanOpWithPolyTree(ClipType.Union, [...occupied], null, occupiedTree, FillRule.EvenOdd)
    booleanOpWithPolyTree(
      ClipType.Difference,
      [counterClockwise(hull)],
      polyTreeToPaths64(occupiedTree),
      gapTree,
      FillRule.NonZero
    )
  } catch {
    return null
  }
  let selectedPath: Path64 | undefined
  let selectedArea = 0
  const visit = (parent: PolyPath64): boolean => {
    for (let index = 0; index < parent.count; index += 1) {
      let child: PolyPath64
      try {
        child = parent.child(index)
      } catch {
        return false
      }
      if (!child.isHole && child.polygon !== null) {
        let netArea = Math.abs(area(child.polygon))
        for (let holeIndex = 0; holeIndex < child.count; holeIndex += 1) {
          let hole: PolyPath64
          try {
            hole = child.child(holeIndex)
          } catch {
            return false
          }
          if (hole.isHole && hole.polygon !== null) netArea -= Math.abs(area(hole.polygon))
        }
        if (!Number.isFinite(netArea) || netArea < 0) return false
        const key = canonicalRing(child.polygon)
        const selectedKey = selectedPath === undefined ? undefined : canonicalRing(selectedPath)
        if (netArea > selectedArea || (netArea === selectedArea && key < (selectedKey ?? key))) {
          selectedPath = child.polygon
          selectedArea = netArea
        }
      }
      if (!visit(child)) return false
    }
    return true
  }
  if (!visit(gapTree)) return null
  if (selectedPath === undefined) return undefined
  const aabb = gridPathAabb(selectedPath)
  if (aabb === undefined) return null
  return {
    path: selectedPath.map(({ x, y }) => ({ x: fromGrid(x), y: fromGrid(y) })),
    areaMm2: selectedArea / 1_000_000,
    aabb
  }
}

function countEnclosedOccupiedCavities(occupied: ReadonlyArray<Path64>): number | undefined {
  if (occupied.length === 0) return 0
  const tree = new PolyTree64()
  try {
    // occupied pieces are solids regardless of source-ring winding
    booleanOpWithPolyTree(ClipType.Union, [...occupied], null, tree, FillRule.EvenOdd)
  } catch {
    return undefined
  }
  let count = 0
  const visit = (parent: PolyPath64): boolean => {
    for (let index = 0; index < parent.count; index += 1) {
      let child: PolyPath64
      try {
        child = parent.child(index)
      } catch {
        return false
      }
      if (child.isHole) count += 1
      if (!visit(child)) return false
    }
    return true
  }
  return visit(tree) ? count : undefined
}

function envelopeAspectRatio(paths: ReadonlyArray<Path64>): number | undefined {
  const points = paths.flat()
  const first = points[0]
  if (first === undefined) return undefined
  let minX = first.x
  let maxX = first.x
  let minY = first.y
  let maxY = first.y
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  const width = maxX - minX
  const height = maxY - minY
  const shortSide = Math.min(width, height)
  const longSide = Math.max(width, height)
  if (shortSide <= 0 || !Number.isFinite(shortSide) || !Number.isFinite(longSide)) return undefined
  return longSide / shortSide
}

function largestNetRegionArea(tree: PolyPath64): number | undefined {
  let largest = 0
  const visit = (parent: PolyPath64): boolean => {
    for (let index = 0; index < parent.count; index += 1) {
      let child: PolyPath64
      try {
        child = parent.child(index)
      } catch {
        return false
      }
      if (!child.isHole) {
        if (child.polygon === null) return false
        let netArea = Math.abs(area(child.polygon))
        for (let holeIndex = 0; holeIndex < child.count; holeIndex += 1) {
          const hole = child.child(holeIndex)
          if (hole.isHole && hole.polygon !== null) netArea -= Math.abs(area(hole.polygon))
        }
        if (!Number.isFinite(netArea) || netArea < 0) return false
        largest = Math.max(largest, netArea)
      }
      if (!visit(child)) return false
    }
    return true
  }
  return visit(tree) ? largest : undefined
}

function measureContactGraph(polygons: ReadonlyArray<InternalPolygonWithBounds>) {
  const neighbors = polygons.map(() => new Set<number>())
  for (let firstIndex = 0; firstIndex < polygons.length; firstIndex += 1) {
    const first = polygons[firstIndex]
    if (first === undefined) return undefined
    for (let secondIndex = 0; secondIndex < firstIndex; secondIndex += 1) {
      const second = polygons[secondIndex]
      if (second === undefined) return undefined
      const contact = measureSharedConvexPolygonBoundaryContact(first, second)
      if (contact === undefined) return undefined
      if (contact.lengthMm > 0) {
        neighbors[firstIndex]?.add(secondIndex)
        neighbors[secondIndex]?.add(firstIndex)
      }
    }
  }
  const visited = new Set<number>()
  let positiveContactComponentCount = 0
  let largestPositiveContactComponentSize = 0
  for (let start = 0; start < polygons.length; start += 1) {
    if (visited.has(start)) continue
    positiveContactComponentCount += 1
    let size = 0
    const pending = [start]
    visited.add(start)
    while (pending.length > 0) {
      const current = pending.pop()
      if (current === undefined) continue
      size += 1
      for (const neighbor of neighbors[current] ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          pending.push(neighbor)
        }
      }
    }
    largestPositiveContactComponentSize = Math.max(largestPositiveContactComponentSize, size)
  }
  return {
    positiveContactComponentCount,
    isolatedPieceCount: neighbors.filter((neighborsForPiece) => neighborsForPiece.size === 0).length,
    largestPositiveContactComponentSize
  }
}

function convexHull(points: ReadonlyArray<{ readonly x: number; readonly y: number }>): Path64 {
  const unique = [...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values()].sort(
    (first, second) => first.x - second.x || first.y - second.y
  )
  if (unique.length <= 1) return unique
  const lower: Path64 = []
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop()
    lower.push(point)
  }
  const upper: Path64 = []
  for (const point of [...unique].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop()
    upper.push(point)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

function cross(
  origin: { readonly x: number; readonly y: number } | undefined,
  first: { readonly x: number; readonly y: number } | undefined,
  second: { readonly x: number; readonly y: number }
): number {
  if (origin === undefined || first === undefined) return 0
  return (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x)
}

function signedArea(path: Path64): number {
  return area(path)
}

function counterClockwise(path: Path64): Path64 {
  return signedArea(path) >= 0 ? path : [...path].reverse()
}
