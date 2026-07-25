import {
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
import {
  hasPositiveCanonicalGridBoundaryContact,
  measureCanonicalGridBoundaryContact
} from './canonicalGridContact.js'
import { fromGrid, toGridMm } from './clipper2OffsetPolicy.js'
import type { InternalPoint } from './internalGeometry.js'
import {
  canonicalGridAbsoluteDoubledArea,
  canonicalGridConvexHull,
  canonicalGridCounterClockwise,
  canonicalGridSignedDoubledArea,
  compareBigInts,
  doubledGridAreaToMm2
} from './canonicalGridMath.js'

export interface CanonicalLayoutTopology {
  readonly enclosedCavityCount: number
  readonly largestOccupiedHullGapRatio: number
  readonly occupiedEnvelopeAspectRatio: number
  readonly positiveContactComponentCount: number
  readonly isolatedPieceCount: number
  readonly largestPositiveContactComponentSize: number
  readonly largestPositiveContactComponentRatio: number
}

/** Exact grid-area representation of the topology hull-gap ratio. */
export interface CanonicalLayoutTopologyExact {
  readonly topology: CanonicalLayoutTopology
  /** Rounded display/backward-compatibility projection; never use for exact ranking. */
  readonly hullGapDoubledAreaGrid2: number
  /** Rounded display/backward-compatibility projection; never use for exact ranking. */
  readonly hullDoubledAreaGrid2: number
  readonly exactHullGapDoubledAreaGrid2: string
  readonly exactHullDoubledAreaGrid2: string
}

export interface CanonicalEnclosedCavityMetrics {
  readonly count: number
  readonly totalAreaMm2: number
  readonly totalDoubledAreaGrid2: string
}

export interface CanonicalLayoutContactMetrics {
  readonly sharedBoundaryLengthMm: number
  readonly contactUnits: number
  readonly totalStructuralContacts: number
  readonly dominantStructuralContacts: number
}

export interface CanonicalLayoutEnvelopeMetrics {
  readonly areaMm2: number
  readonly maximumSideMm: number
  readonly spanMm: number
  readonly occupiedHullWasteRatio: number
  readonly maximumSideGrid: number
  readonly spanGrid: number
  readonly envelopeAreaGrid2: string
  readonly occupiedDoubledAreaGrid2: string
  readonly hullDoubledAreaGrid2: string
}

interface CanonicalPlacedPolygon {
  readonly pieceId: PieceId
  readonly path: Path64
}

export interface CanonicalGridAabb {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

export interface CanonicalWorldGridPoint {
  readonly x: number
  readonly y: number
}

/** Authoritative collision path: add in millimetres, then round once to the grid. */
export function placedCollisionWorldGridPath(
  entry: IrregularPlacedPiece
): ReadonlyArray<CanonicalWorldGridPoint> | undefined {
  const { translateX, translateY } = entry.placement.transform
  const path = entry.collisionGeometry.polygon.points.map((point) => {
    const x = toGridMm(point.x + translateX)
    const y = toGridMm(point.y + translateY)
    return {
      x: x === 0 ? 0 : x,
      y: y === 0 ? 0 : y
    }
  })
  return path.length < 3 || path.some(({ x, y }) => x === undefined || y === undefined)
    ? undefined
    : path.filter(
        (point): point is CanonicalWorldGridPoint =>
          point.x !== undefined && point.y !== undefined
      )
}

export interface CanonicalLayoutStructuralAnalysis {
  readonly pieces: ReadonlyArray<{
    readonly pieceId: PieceId
    readonly aabb: CanonicalGridAabb
    readonly areaGrid2: number
    readonly doubledAreaGrid2: string
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
  return measureCanonicalLayoutTopologyExact(placed)?.topology
}

/** Sheet-free topology with a hull-gap ratio preserved as exact grid-area terms. */
export function measureCanonicalLayoutTopologyExact(
  placed: ReadonlyArray<IrregularPlacedPiece>
): CanonicalLayoutTopologyExact | undefined {
  const polygons = canonicalPlacedPolygons(placed)
  if (polygons === undefined) return undefined
  const hull = canonicalGridConvexHull(
    polygons.flatMap(({ path }) => path.map(({ x, y }) => ({ x, y })))
  )
  if (hull === undefined) return undefined
  const hullDoubledArea = canonicalGridAbsoluteDoubledArea(hull)
  const largestGapDoubledArea = largestHullGapDoubledArea(
    hull,
    polygons.map(({ path }) => path)
  )
  const enclosedCavityCount = countEnclosedOccupiedCavities(polygons.map(({ path }) => path))
  const occupiedEnvelopeAspectRatio = envelopeAspectRatio(polygons.map(({ path }) => path))
  const graph = measureContactGraph(polygons.map(({ path }) => path))
  if (
    hullDoubledArea === undefined ||
    largestGapDoubledArea === undefined ||
    enclosedCavityCount === undefined ||
    occupiedEnvelopeAspectRatio === undefined ||
    graph === undefined
  ) {
    return undefined
  }
  const largestOccupiedHullGapRatio =
    hullDoubledArea === 0n
      ? 0
      : Number(largestGapDoubledArea) / Number(hullDoubledArea)
  return Number.isFinite(largestOccupiedHullGapRatio)
    ? {
        topology: {
          enclosedCavityCount,
          largestOccupiedHullGapRatio,
          occupiedEnvelopeAspectRatio,
          ...graph,
          largestPositiveContactComponentRatio:
            polygons.length === 0 ? 0 : graph.largestPositiveContactComponentSize / polygons.length
        },
        hullGapDoubledAreaGrid2: Number(largestGapDoubledArea),
        hullDoubledAreaGrid2: Number(hullDoubledArea),
        exactHullGapDoubledAreaGrid2: largestGapDoubledArea.toString(),
        exactHullDoubledAreaGrid2: hullDoubledArea.toString()
      }
    : undefined
}

/** Sheet-free enclosed-cavity count and area on the canonical collision grid. */
export function measureCanonicalEnclosedCavities(
  placed: ReadonlyArray<IrregularPlacedPiece>
): CanonicalEnclosedCavityMetrics | undefined {
  const polygons = canonicalPlacedPolygons(placed)
  return polygons === undefined
    ? undefined
    : measureEnclosedOccupiedCavities(polygons.map(({ path }) => path))
}

/** Complete-layout contact metrics measured only after snapping world geometry to the grid. */
export function measureCanonicalLayoutContacts(
  placed: ReadonlyArray<IrregularPlacedPiece>
): CanonicalLayoutContactMetrics | undefined {
  const polygons = canonicalPlacedPolygons(placed)?.toSorted((first, second) =>
    first.pieceId.localeCompare(second.pieceId)
  )
  if (polygons === undefined) return undefined
  let sharedBoundaryLengthMm = 0
  let contactUnits = 0
  let totalStructuralContacts = 0
  const signatureCounts = new Map<string, number>()
  for (let firstIndex = 0; firstIndex < polygons.length; firstIndex += 1) {
    const first = polygons[firstIndex]
    if (first === undefined) return undefined
    for (let secondIndex = 0; secondIndex < firstIndex; secondIndex += 1) {
      const second = polygons[secondIndex]
      if (second === undefined) return undefined
      const contact = measureCanonicalGridBoundaryContact(first.path, second.path)
      if (contact === undefined) return undefined
      sharedBoundaryLengthMm += contact.lengthMm
      contactUnits += contact.normalizedUnits
      totalStructuralContacts += contact.nearCompleteStructuralContactCount
      for (const signature of contact.nearCompleteStructuralContactSignatures) {
        const count = (signatureCounts.get(signature) ?? 0) + 1
        if (!Number.isSafeInteger(count)) return undefined
        signatureCounts.set(signature, count)
      }
    }
  }
  let dominantStructuralContacts = 0
  for (const count of signatureCounts.values()) {
    dominantStructuralContacts = Math.max(dominantStructuralContacts, count)
  }
  return [
    sharedBoundaryLengthMm,
    contactUnits,
    totalStructuralContacts,
    dominantStructuralContacts
  ].every(Number.isFinite)
    ? {
        sharedBoundaryLengthMm,
        contactUnits,
        totalStructuralContacts,
        dominantStructuralContacts
      }
    : undefined
}

/** Complete-layout envelope and hull metrics measured on canonical grid paths. */
export function measureCanonicalLayoutEnvelope(
  placed: ReadonlyArray<IrregularPlacedPiece>
): CanonicalLayoutEnvelopeMetrics | undefined {
  const polygons = canonicalPlacedPolygons(placed)
  if (polygons === undefined || polygons.length === 0) return undefined
  const paths = polygons.map(({ path }) => path)
  const points = paths.flat()
  const minimumX = Math.min(...points.map(({ x }) => x))
  const minimumY = Math.min(...points.map(({ y }) => y))
  const maximumX = Math.max(...points.map(({ x }) => x))
  const maximumY = Math.max(...points.map(({ y }) => y))
  const widthGrid = maximumX - minimumX
  const heightGrid = maximumY - minimumY
  const occupiedAreas = paths.map(canonicalGridAbsoluteDoubledArea)
  const hull = canonicalGridConvexHull(points)
  if (occupiedAreas.some((value) => value === undefined) || hull === undefined) return undefined
  const definedOccupiedAreas = occupiedAreas.filter(
    (value): value is bigint => value !== undefined
  )
  const occupiedDoubledAreaGrid2 = definedOccupiedAreas.reduce(
    (sum, value) => sum + value,
    0n
  )
  const hullDoubledAreaGrid2 = canonicalGridAbsoluteDoubledArea(hull)
  if (hullDoubledAreaGrid2 === undefined) return undefined
  if (
    ![
      minimumX,
      minimumY,
      maximumX,
      maximumY,
      widthGrid,
      heightGrid,
    ].every(Number.isFinite) ||
    widthGrid < 0 ||
    heightGrid < 0 ||
    occupiedDoubledAreaGrid2 < 0n ||
    hullDoubledAreaGrid2 < occupiedDoubledAreaGrid2
  ) {
    return undefined
  }
  const widthMm = fromGrid(widthGrid)
  const heightMm = fromGrid(heightGrid)
  const occupiedHullWasteRatio =
    hullDoubledAreaGrid2 === 0n
      ? 0
      : Number(hullDoubledAreaGrid2 - occupiedDoubledAreaGrid2) /
        Number(hullDoubledAreaGrid2)
  const envelopeAreaGrid2 = BigInt(widthGrid) * BigInt(heightGrid)
  const metrics = {
    areaMm2: widthMm * heightMm,
    maximumSideMm: Math.max(widthMm, heightMm),
    spanMm: widthMm + heightMm,
    occupiedHullWasteRatio,
    maximumSideGrid: Math.max(widthGrid, heightGrid),
    spanGrid: widthGrid + heightGrid,
    envelopeAreaGrid2: envelopeAreaGrid2.toString(),
    occupiedDoubledAreaGrid2: occupiedDoubledAreaGrid2.toString(),
    hullDoubledAreaGrid2: hullDoubledAreaGrid2.toString()
  }
  return [
    metrics.areaMm2,
    metrics.maximumSideMm,
    metrics.spanMm,
    metrics.occupiedHullWasteRatio,
    metrics.maximumSideGrid,
    metrics.spanGrid
  ].every(Number.isFinite) &&
    occupiedHullWasteRatio >= 0 &&
    occupiedHullWasteRatio <= 1
    ? metrics
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
      if (
        polyTreeToPaths64(intersection).some((path) => {
          const doubledArea = canonicalGridAbsoluteDoubledArea(path)
          return doubledArea === undefined || doubledArea > 0n
        })
      ) {
        return false
      }
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
      const hasPositiveContact = hasPositiveCanonicalGridBoundaryContact(first.path, second.path)
      if (hasPositiveContact === undefined) return undefined
      if (hasPositiveContact) {
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
      const intersectionAreas = polyTreeToPaths64(intersection).map(
        canonicalGridAbsoluteDoubledArea
      )
      if (intersectionAreas.some((value) => value === undefined)) return undefined
      const intersectionDoubledAreaGrid2 = intersectionAreas
        .filter((value): value is bigint => value !== undefined)
        .reduce(
        (sum, value) => sum + value,
        0n
      )
      if (intersectionDoubledAreaGrid2 > 0n) {
        const pair = orderedPiecePair(first.pieceId, second.pieceId)
        positiveAreaConflicts.push(pair)
        const areaMm2 = doubledGridAreaToMm2(intersectionDoubledAreaGrid2)
        if (areaMm2 === undefined) return undefined
        positiveAreaConflictMeasurements.push({
          pair,
          areaMm2
        })
      }
    }
  }
  const positiveContactComponents = contactComponents(polygons, neighbors)
  if (positiveContactComponents === undefined) return undefined
  const hull = canonicalGridConvexHull(polygons.flatMap(({ path }) => path))
  if (hull === undefined) return undefined
  const largestHullGap = largestHullGapRegion(hull, polygons.map(({ path }) => path))
  if (largestHullGap === null) return undefined
  const pieces = polygons.map(({ pieceId, path }) => {
    const aabb = gridPathAabb(path)
    const doubledAreaGrid2 = canonicalGridAbsoluteDoubledArea(path)
    return aabb === undefined || doubledAreaGrid2 === undefined
      ? undefined
      : {
          pieceId,
          aabb,
          areaGrid2: Number(doubledAreaGrid2) / 2,
          doubledAreaGrid2: doubledAreaGrid2.toString()
        }
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
        readonly doubledAreaGrid2: string
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
    const worldPath = placedCollisionWorldGridPath(entry)
    if (worldPath === undefined) return undefined
    const path: Path64 = worldPath.map(({ x, y }) => ({ x, y }))
    const doubledArea = canonicalGridSignedDoubledArea(path)
    if (path.length < 3 || doubledArea === undefined || doubledArea === 0n) return undefined
    result.push({
      pieceId: entry.placement.pieceId ?? entry.placement.sourcePieceId,
      path
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
  const areaEntries = polygons.map(({ pieceId, path }) => {
    const doubledArea = canonicalGridAbsoluteDoubledArea(path)
    return doubledArea === undefined ? undefined : ([pieceId, doubledArea] as const)
  })
  if (areaEntries.some((entry) => entry === undefined)) return undefined
  const areaById = new Map(
    areaEntries.filter(
      (entry): entry is readonly [PieceId, bigint] => entry !== undefined
    )
  )
  return components.toSorted((first, second) => {
    const firstArea = first.reduce((sum, pieceId) => sum + (areaById.get(pieceId) ?? 0n), 0n)
    const secondArea = second.reduce((sum, pieceId) => sum + (areaById.get(pieceId) ?? 0n), 0n)
    return (
      second.length - first.length ||
      compareBigInts(secondArea, firstArea) ||
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

function largestHullGapDoubledArea(
  hull: Path64,
  occupied: ReadonlyArray<Path64>
): bigint | undefined {
  if (hull.length < 3) return 0n
  const occupiedTree = new PolyTree64()
  const gapTree = new PolyTree64()
  const orientedHull = canonicalGridCounterClockwise(hull)
  if (orientedHull === undefined) return undefined
  try {
    booleanOpWithPolyTree(ClipType.Union, [...occupied], null, occupiedTree, FillRule.EvenOdd)
    booleanOpWithPolyTree(
      ClipType.Difference,
      [orientedHull],
      polyTreeToPaths64(occupiedTree),
      gapTree,
      FillRule.NonZero
    )
  } catch {
    return undefined
  }
  return largestNetRegionDoubledArea(gapTree)
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
  const orientedHull = canonicalGridCounterClockwise(hull)
  if (orientedHull === undefined) return null
  try {
    booleanOpWithPolyTree(ClipType.Union, [...occupied], null, occupiedTree, FillRule.EvenOdd)
    booleanOpWithPolyTree(
      ClipType.Difference,
      [orientedHull],
      polyTreeToPaths64(occupiedTree),
      gapTree,
      FillRule.NonZero
    )
  } catch {
    return null
  }
  let selectedPath: Path64 | undefined
  let selectedDoubledArea = 0n
  const visit = (parent: PolyPath64): boolean => {
    for (let index = 0; index < parent.count; index += 1) {
      let child: PolyPath64
      try {
        child = parent.child(index)
      } catch {
        return false
      }
      if (!child.isHole && child.polygon !== null) {
        const netDoubledArea = netSolidDoubledArea(child)
        if (netDoubledArea === undefined) return false
        const key = canonicalRing(child.polygon)
        const selectedKey = selectedPath === undefined ? undefined : canonicalRing(selectedPath)
        if (
          netDoubledArea > selectedDoubledArea ||
          (netDoubledArea === selectedDoubledArea && key < (selectedKey ?? key))
        ) {
          selectedPath = child.polygon
          selectedDoubledArea = netDoubledArea
        }
      }
      if (!visit(child)) return false
    }
    return true
  }
  if (!visit(gapTree)) return null
  if (selectedPath === undefined) return undefined
  const aabb = gridPathAabb(selectedPath)
  const areaMm2 = doubledGridAreaToMm2(selectedDoubledArea)
  if (aabb === undefined || areaMm2 === undefined) return null
  return {
    path: selectedPath.map(({ x, y }) => ({ x: fromGrid(x), y: fromGrid(y) })),
    areaMm2,
    aabb
  }
}

function countEnclosedOccupiedCavities(occupied: ReadonlyArray<Path64>): number | undefined {
  return measureEnclosedOccupiedCavities(occupied)?.count
}

function measureEnclosedOccupiedCavities(
  occupied: ReadonlyArray<Path64>
): CanonicalEnclosedCavityMetrics | undefined {
  if (occupied.length === 0) {
    return { count: 0, totalAreaMm2: 0, totalDoubledAreaGrid2: '0' }
  }
  const tree = new PolyTree64()
  try {
    // occupied pieces are solids regardless of source-ring winding
    booleanOpWithPolyTree(ClipType.Union, [...occupied], null, tree, FillRule.EvenOdd)
  } catch {
    return undefined
  }
  let count = 0
  let totalDoubledAreaGrid2 = 0n
  const visit = (parent: PolyPath64): boolean => {
    for (let index = 0; index < parent.count; index += 1) {
      let child: PolyPath64
      try {
        child = parent.child(index)
      } catch {
        return false
      }
      if (child.isHole) {
        if (child.polygon === null) return false
        const cavityDoubledArea = canonicalGridAbsoluteDoubledArea(child.polygon)
        if (cavityDoubledArea === undefined) return false
        count += 1
        totalDoubledAreaGrid2 += cavityDoubledArea
      }
      if (!visit(child)) return false
    }
    return true
  }
  if (!visit(tree)) return undefined
  const totalAreaMm2 = doubledGridAreaToMm2(totalDoubledAreaGrid2)
  return totalAreaMm2 === undefined
    ? undefined
    : { count, totalAreaMm2, totalDoubledAreaGrid2: totalDoubledAreaGrid2.toString() }
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

function netSolidDoubledArea(node: PolyPath64): bigint | undefined {
  if (node.polygon === null) return undefined
  const outerArea = canonicalGridAbsoluteDoubledArea(node.polygon)
  if (outerArea === undefined) return undefined
  let netArea = outerArea
  for (let holeIndex = 0; holeIndex < node.count; holeIndex += 1) {
    let hole: PolyPath64
    try {
      hole = node.child(holeIndex)
    } catch {
      return undefined
    }
    if (!hole.isHole || hole.polygon === null) continue
    const holeArea = canonicalGridAbsoluteDoubledArea(hole.polygon)
    if (holeArea === undefined) return undefined
    netArea -= holeArea
  }
  return netArea >= 0n ? netArea : undefined
}

function largestNetRegionDoubledArea(tree: PolyPath64): bigint | undefined {
  let largest = 0n
  const visit = (parent: PolyPath64): boolean => {
    for (let index = 0; index < parent.count; index += 1) {
      let child: PolyPath64
      try {
        child = parent.child(index)
      } catch {
        return false
      }
      if (!child.isHole) {
        const netArea = netSolidDoubledArea(child)
        if (netArea === undefined) return false
        if (netArea > largest) largest = netArea
      }
      if (!visit(child)) return false
    }
    return true
  }
  return visit(tree) ? largest : undefined
}

function measureContactGraph(polygons: ReadonlyArray<Path64>) {
  const neighbors = polygons.map(() => new Set<number>())
  for (let firstIndex = 0; firstIndex < polygons.length; firstIndex += 1) {
    const first = polygons[firstIndex]
    if (first === undefined) return undefined
    for (let secondIndex = 0; secondIndex < firstIndex; secondIndex += 1) {
      const second = polygons[secondIndex]
      if (second === undefined) return undefined
      const hasPositiveContact = hasPositiveCanonicalGridBoundaryContact(first, second)
      if (hasPositiveContact === undefined) return undefined
      if (hasPositiveContact) {
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
