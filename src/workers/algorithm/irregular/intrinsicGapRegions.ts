import {
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
import {
  canonicalGridAbsoluteDoubledArea,
  canonicalGridClockwise,
  canonicalGridConvexHull,
  canonicalGridCounterClockwise,
  canonicalGridPointOnSegment,
  canonicalGridSignedDoubledArea,
  compareBigInts,
  doubledGridAreaToMm2
} from '../../irregular/canonicalGridMath.js'

export interface CanonicalIntrinsicGapRegion {
  readonly kind: 'enclosed-cavity' | 'hull-open-gap'
  readonly boundary: Path64
  readonly holes: ReadonlyArray<Path64>
  readonly areaMm2: number
  readonly doubledAreaGrid2: string
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
  const hull = canonicalGridConvexHull(paths.flat())
  if (hull === undefined) return undefined
  if (hull.length < 3) return []
  const occupiedTree = new PolyTree64()
  const gapTree = new PolyTree64()
  try {
    booleanOpWithPolyTree(ClipType.Union, paths, null, occupiedTree, FillRule.EvenOdd)
    booleanOpWithPolyTree(
      ClipType.Difference,
      [canonicalGridCounterClockwise(hull) ?? hull],
      polyTreeToPaths64(occupiedTree),
      gapTree,
      FillRule.NonZero
    )
  } catch {
    return undefined
  }
  const regions: CanonicalIntrinsicGapRegion[] = []
  if (!collectRegions(gapTree, hull, regions)) return undefined
  return regions.toSorted(
    (first, second) =>
      compareBigInts(BigInt(first.doubledAreaGrid2), BigInt(second.doubledAreaGrid2)) ||
      first.canonicalKey.localeCompare(second.canonicalKey)
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
  const boundary = canonicalGridCounterClockwise(region.boundary)
  const holes = region.holes.map(canonicalGridClockwise)
  if (boundary === undefined || holes.some((path) => path === undefined)) return false
  const solid = [
    boundary,
    ...holes.filter((path): path is Path64 => path !== undefined)
  ]
  const difference = new PolyTree64()
  try {
    booleanOpWithPolyTree(
      ClipType.Difference,
      [canonicalGridCounterClockwise(candidatePath) ?? candidatePath],
      solid,
      difference,
      FillRule.NonZero
    )
  } catch {
    return false
  }
  return totalPositiveDoubledArea(difference) === 0n
}

function collectRegions(
  parent: PolyPath64,
  hull: Path64,
  result: CanonicalIntrinsicGapRegion[]
): boolean {
  for (let index = 0; index < parent.count; index += 1) {
    let child: PolyPath64
    try {
      child = parent.child(index)
    } catch {
      return false
    }
    if (!child.isHole && child.polygon !== null) {
      const holes: Path64[] = []
      const outerDoubledArea = canonicalGridAbsoluteDoubledArea(child.polygon)
      if (outerDoubledArea === undefined) return false
      let netDoubledArea = outerDoubledArea
      for (let holeIndex = 0; holeIndex < child.count; holeIndex += 1) {
        let hole: PolyPath64
        try {
          hole = child.child(holeIndex)
        } catch {
          return false
        }
        if (hole.isHole && hole.polygon !== null) {
          holes.push(hole.polygon)
          const holeDoubledArea = canonicalGridAbsoluteDoubledArea(hole.polygon)
          if (holeDoubledArea === undefined) return false
          netDoubledArea -= holeDoubledArea
        }
      }
      const aabb = pathBounds(child.polygon)
      const areaMm2 = doubledGridAreaToMm2(netDoubledArea)
      const boundary = canonicalGridCounterClockwise(child.polygon)
      if (netDoubledArea <= 0n || aabb === undefined || areaMm2 === undefined || boundary === undefined) {
        return false
      }
      const orderedHoles = holes
        .map(canonicalGridClockwise)
        .filter((path): path is Path64 => path !== undefined)
        .toSorted((first, second) => canonicalRing(first).localeCompare(canonicalRing(second)))
      if (orderedHoles.length !== holes.length) return false
      result.push({
        kind: pathTouchesBoundary(boundary, hull) ? 'hull-open-gap' : 'enclosed-cavity',
        boundary,
        holes: orderedHoles,
        areaMm2,
        doubledAreaGrid2: netDoubledArea.toString(),
        aabb,
        canonicalKey: `${canonicalRing(boundary)}|${orderedHoles.map(canonicalRing).join('|')}`
      })
    }
    if (!collectRegions(child, hull, result)) return false
  }
  return true
}

function pathTouchesBoundary(path: Path64, boundary: Path64): boolean {
  return path.some((point) =>
    boundary.some((start, index) => {
      const end = boundary[(index + 1) % boundary.length]
      if (end === undefined) return false
      return (
        canonicalGridPointOnSegment(point, start, end)
      )
    })
  )
}

function placedPath(placed: IrregularPlacedPiece): Path64 | undefined {
  const path: Path64 = []
  for (const point of placed.collisionGeometry.polygon.points) {
    const x = toGridMm(point.x + placed.placement.transform.translateX)
    const y = toGridMm(point.y + placed.placement.transform.translateY)
    if (x === undefined || y === undefined) return undefined
    path.push({ x, y })
  }
  const signedDoubledArea = canonicalGridSignedDoubledArea(path)
  return path.length >= 3 && signedDoubledArea !== undefined && signedDoubledArea !== 0n
    ? canonicalGridCounterClockwise(path)
    : undefined
}

function totalPositiveDoubledArea(parent: PolyPath64): bigint | undefined {
  let total = 0n
  const visit = (node: PolyPath64): boolean => {
    for (let index = 0; index < node.count; index += 1) {
      let child: PolyPath64
      try {
        child = node.child(index)
      } catch {
        return false
      }
      if (!child.isHole && child.polygon !== null) {
        const doubledArea = canonicalGridAbsoluteDoubledArea(child.polygon)
        if (doubledArea === undefined) return false
        total += doubledArea
      }
      if (!visit(child)) return false
    }
    return true
  }
  return visit(parent) ? total : undefined
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
