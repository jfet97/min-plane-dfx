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
import type {
  IrregularPlacedPiece,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { toGridMm } from '../../irregular/clipper2OffsetPolicy.js'

export interface CanonicalIntrinsicGapRegion {
  readonly boundary: Path64
  readonly holes: ReadonlyArray<Path64>
  readonly areaMm2: number
  readonly aabb: {
    readonly minX: number
    readonly minY: number
    readonly maxX: number
    readonly maxY: number
  }
  readonly canonicalKey: string
}

/** Exact canonical convex-hull minus occupied-union regions. */
export function deriveCanonicalIntrinsicGapRegions(
  placed: ReadonlyArray<IrregularPlacedPiece>
): ReadonlyArray<CanonicalIntrinsicGapRegion> | undefined {
  const occupied = placed.map(placedPath)
  if (occupied.some((path) => path === undefined)) return undefined
  const paths = occupied.filter((path): path is Path64 => path !== undefined)
  const hull = convexHull(paths.flat())
  if (hull.length < 3) return []
  const occupiedTree = new PolyTree64()
  const gapTree = new PolyTree64()
  try {
    booleanOpWithPolyTree(ClipType.Union, paths, null, occupiedTree, FillRule.EvenOdd)
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
  const regions: CanonicalIntrinsicGapRegion[] = []
  if (!collectRegions(gapTree, regions)) return undefined
  return regions.toSorted(
    (first, second) =>
      first.areaMm2 - second.areaMm2 || first.canonicalKey.localeCompare(second.canonicalKey)
  )
}

/** Exact zero-positive-area test for candidate minus one gap solid. */
export function candidateContainedInIntrinsicGap(
  moving: TransformedCollisionGeometry,
  point: { readonly x: number; readonly y: number },
  region: CanonicalIntrinsicGapRegion
): boolean {
  const candidate = moving.polygon.points.map(({ x, y }) => ({
    x: toGridMm(x + point.x),
    y: toGridMm(y + point.y)
  }))
  if (candidate.some(({ x, y }) => x === undefined || y === undefined)) return false
  const candidatePath = candidate.map(({ x, y }) => ({ x: x ?? 0, y: y ?? 0 }))
  const solid = [counterClockwise(region.boundary), ...region.holes.map(clockwise)]
  const difference = new PolyTree64()
  try {
    booleanOpWithPolyTree(
      ClipType.Difference,
      [counterClockwise(candidatePath)],
      solid,
      difference,
      FillRule.NonZero
    )
  } catch {
    return false
  }
  return totalPositiveArea(difference) === 0
}

function collectRegions(parent: PolyPath64, result: CanonicalIntrinsicGapRegion[]): boolean {
  for (let index = 0; index < parent.count; index += 1) {
    let child: PolyPath64
    try {
      child = parent.child(index)
    } catch {
      return false
    }
    if (!child.isHole && child.polygon !== null) {
      const holes: Path64[] = []
      let netArea = Math.abs(area(child.polygon))
      for (let holeIndex = 0; holeIndex < child.count; holeIndex += 1) {
        let hole: PolyPath64
        try {
          hole = child.child(holeIndex)
        } catch {
          return false
        }
        if (hole.isHole && hole.polygon !== null) {
          holes.push(hole.polygon)
          netArea -= Math.abs(area(hole.polygon))
        }
      }
      const aabb = pathBounds(child.polygon)
      if (!Number.isFinite(netArea) || netArea <= 0 || aabb === undefined) return false
      const boundary = counterClockwise(child.polygon)
      const orderedHoles = holes
        .map(clockwise)
        .toSorted((first, second) => canonicalRing(first).localeCompare(canonicalRing(second)))
      result.push({
        boundary,
        holes: orderedHoles,
        areaMm2: netArea / 1_000_000,
        aabb,
        canonicalKey: `${canonicalRing(boundary)}|${orderedHoles.map(canonicalRing).join('|')}`
      })
    }
    if (!collectRegions(child, result)) return false
  }
  return true
}

function placedPath(placed: IrregularPlacedPiece): Path64 | undefined {
  const path: Path64 = []
  for (const point of placed.collisionGeometry.polygon.points) {
    const x = toGridMm(point.x + placed.placement.transform.translateX)
    const y = toGridMm(point.y + placed.placement.transform.translateY)
    if (x === undefined || y === undefined) return undefined
    path.push({ x, y })
  }
  return path.length >= 3 && area(path) !== 0 ? counterClockwise(path) : undefined
}

function totalPositiveArea(parent: PolyPath64): number | undefined {
  let total = 0
  const visit = (node: PolyPath64): boolean => {
    for (let index = 0; index < node.count; index += 1) {
      let child: PolyPath64
      try {
        child = node.child(index)
      } catch {
        return false
      }
      if (!child.isHole && child.polygon !== null) total += Math.abs(area(child.polygon))
      if (!visit(child)) return false
    }
    return true
  }
  return visit(parent) ? total : undefined
}

function convexHull(points: ReadonlyArray<{ readonly x: number; readonly y: number }>): Path64 {
  const unique = [
    ...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values()
  ].sort((first, second) => first.x - second.x || first.y - second.y)
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

function pathBounds(path: Path64): CanonicalIntrinsicGapRegion['aabb'] | undefined {
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

function canonicalRing(path: Path64): string {
  const variants = [path, [...path].reverse()].flatMap((sequence) =>
    sequence.map((_, offset) =>
      [...sequence.slice(offset), ...sequence.slice(0, offset)]
        .map(({ x, y }) => `${x},${y}`)
        .join(';')
    )
  )
  return variants.toSorted()[0] ?? ''
}

function counterClockwise(path: Path64): Path64 {
  return area(path) >= 0 ? path : [...path].reverse()
}

function clockwise(path: Path64): Path64 {
  return area(path) <= 0 ? path : [...path].reverse()
}
