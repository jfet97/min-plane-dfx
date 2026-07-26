import type { InternalPoint, InternalPolygon } from '../internalGeometry.js'
import { GeometryPredicates } from '../geometryPredicates.js'

/** Computes a deterministic structural convex hull without constructing domain objects. */
export function computeConvexHull(points: ReadonlyArray<InternalPoint>): InternalPolygon {
  const sortedPoints = [...points].sort((left, right) => {
    if (left.x !== right.x) return left.x - right.x
    return left.y - right.y
  })
  const uniquePoints = deduplicateSortedPoints(sortedPoints)
  if (uniquePoints.length <= 2) return { points: uniquePoints }

  const lowerHull = buildHullHalf(uniquePoints)
  const upperHull = buildHullHalf([...uniquePoints].reverse())
  return { points: [...lowerHull.slice(0, -1), ...upperHull.slice(0, -1)] }
}

function deduplicateSortedPoints(points: ReadonlyArray<InternalPoint>): InternalPoint[] {
  const uniquePoints: InternalPoint[] = []
  for (const point of points) {
    const previousPoint = uniquePoints.at(-1)
    if (previousPoint?.x === point.x && previousPoint.y === point.y) continue
    uniquePoints.push(point)
  }
  return uniquePoints
}

function buildHullHalf(points: ReadonlyArray<InternalPoint>): InternalPoint[] {
  const hull: InternalPoint[] = []
  for (const point of points) {
    while (hull.length >= 2) {
      const previousPoint = hull.at(-2)
      const lastPoint = hull.at(-1)
      if (previousPoint === undefined || lastPoint === undefined) break
      if (GeometryPredicates.orientation(previousPoint, lastPoint, point) > 0) break
      hull.pop()
    }
    hull.push(point)
  }
  return hull
}
