import type { InternalPoint, InternalPolygonWithBounds } from './internalGeometry.js'
import { areDisjoint } from './convexBounds.js'
import { GeometryPredicates } from './geometryPredicates.js'

/** Exact contact length plus a scale-normalized amount for whole-layout scoring. */
export interface SharedConvexPolygonBoundaryContact {
  readonly lengthMm: number
  readonly normalizedUnits: number
}

/** Measures exact shared boundary length between two already-translated convex polygons. */
export function sharedConvexPolygonBoundaryLength(
  first: InternalPolygonWithBounds,
  second: InternalPolygonWithBounds
): number | undefined {
  if (areDisjoint(first.bounds, second.bounds)) return 0

  let totalLength = 0
  for (const firstEdge of polygonEdges(first.polygon.points)) {
    for (const secondEdge of polygonEdges(second.polygon.points)) {
      const overlapLength = collinearOverlapLength(firstEdge, secondEdge)
      if (overlapLength === undefined) return undefined
      totalLength += overlapLength
      if (!Number.isFinite(totalLength)) return undefined
    }
  }
  return totalLength
}

/**
 * Measures shared boundary relative to the smaller polygon's longest edge.
 * One unit therefore represents contact comparable to one structural edge,
 * while short offset chamfers contribute only a small fraction of one unit.
 */
export function measureSharedConvexPolygonBoundaryContact(
  first: InternalPolygonWithBounds,
  second: InternalPolygonWithBounds
): SharedConvexPolygonBoundaryContact | undefined {
  const lengthMm = sharedConvexPolygonBoundaryLength(first, second)
  if (lengthMm === undefined) return undefined
  if (lengthMm === 0) return { lengthMm: 0, normalizedUnits: 0 }

  const firstLongestEdgeMm = longestPolygonEdgeLength(first.polygon.points)
  const secondLongestEdgeMm = longestPolygonEdgeLength(second.polygon.points)
  if (firstLongestEdgeMm === undefined || secondLongestEdgeMm === undefined) return undefined

  const normalizationLengthMm = Math.min(firstLongestEdgeMm, secondLongestEdgeMm)
  const normalizedUnits = lengthMm / normalizationLengthMm
  if (!Number.isFinite(normalizedUnits) || normalizedUnits < 0) return undefined
  return { lengthMm, normalizedUnits }
}

interface PolygonEdge {
  readonly start: InternalPoint
  readonly end: InternalPoint
}

function polygonEdges(points: ReadonlyArray<InternalPoint>): ReadonlyArray<PolygonEdge> {
  const edges: PolygonEdge[] = []
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    if (start === undefined || end === undefined) return []
    edges.push({ start, end })
  }
  return edges
}

function longestPolygonEdgeLength(points: ReadonlyArray<InternalPoint>): number | undefined {
  let longestEdgeLength = 0
  for (const edge of polygonEdges(points)) {
    const edgeLength = Math.hypot(edge.end.x - edge.start.x, edge.end.y - edge.start.y)
    if (!Number.isFinite(edgeLength) || edgeLength <= 0) return undefined
    longestEdgeLength = Math.max(longestEdgeLength, edgeLength)
  }
  return longestEdgeLength > 0 ? longestEdgeLength : undefined
}

function collinearOverlapLength(first: PolygonEdge, second: PolygonEdge): number | undefined {
  if (
    GeometryPredicates.orientation(first.start, first.end, second.start) !== 0 ||
    GeometryPredicates.orientation(first.start, first.end, second.end) !== 0
  ) {
    return 0
  }

  const dx = first.end.x - first.start.x
  const dy = first.end.y - first.start.y
  const edgeLength = Math.hypot(dx, dy)
  if (!Number.isFinite(edgeLength) || edgeLength <= 0) return undefined

  const useX = Math.abs(dx) >= Math.abs(dy)
  const firstStart = useX ? first.start.x : first.start.y
  const firstEnd = useX ? first.end.x : first.end.y
  const secondStart = useX ? second.start.x : second.start.y
  const secondEnd = useX ? second.end.x : second.end.y
  const overlappingAxisLength =
    Math.min(Math.max(firstStart, firstEnd), Math.max(secondStart, secondEnd)) -
    Math.max(Math.min(firstStart, firstEnd), Math.min(secondStart, secondEnd))
  if (!Number.isFinite(overlappingAxisLength) || overlappingAxisLength <= 0) return 0

  const firstAxisLength = Math.abs(firstEnd - firstStart)
  if (!Number.isFinite(firstAxisLength) || firstAxisLength <= 0) return undefined
  const overlapLength = (overlappingAxisLength * edgeLength) / firstAxisLength
  return Number.isFinite(overlapLength) ? overlapLength : undefined
}
