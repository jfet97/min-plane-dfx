/**
 * Validates the finite, closed-ring geometry used by convex irregular nesting.
 * Coordinates remain in the app's DXF y-up convention; successful validation
 * reports the ring winding without rewriting the supplied vertices.
 */
import type { IrregularPoint } from '@shared/irregular/domain.js'
import { GeometryPredicates } from './geometryPredicates.js'

/**
 * Winding sign shared by every non-collinear turn in a validated y-up ring.
 * `1` represents counter-clockwise turns and `-1` represents clockwise turns.
 */
export type ConvexPolygonWinding = -1 | 1

interface ValidStrictConvexBoundary {
  readonly winding: ConvexPolygonWinding
}

interface InvalidStrictConvexBoundary {
  readonly message: string
}

/** One directed edge of the ordered, implicitly closed input ring. */
interface BoundaryEdge {
  readonly start: IrregularPoint
  readonly end: IrregularPoint
}

/**
 * Result returned by the strict convex simple-ring validator.
 * A valid result contains `winding`; an invalid result contains only `message`.
 */
export type StrictConvexBoundaryValidation = ValidStrictConvexBoundary | InvalidStrictConvexBoundary

/**
 * Public validation boundary for collision polygons.
 *
 * `validateStrictBoundary` accepts ordered vertices in DXF y-up coordinates
 * and returns either their winding sign or a diagnostic message.
 */
export const ConvexPolygonValidation = {
  validateStrictBoundary
} as const

/**
 * Validates the geometric invariant shared by every v2 collision polygon: at
 * least three finite vertices that form a simple ring and turn consistently
 * around a strictly convex boundary.
 *
 * @param points ordered vertices in the app's DXF y-up coordinate system; the
 * final edge from the last point to the first is implicit.
 * @returns `{ winding }` for a valid ring, where the sign is shared by every
 * turn, or `{ message }` describing the rejected invariant.
 *
 * Robust orientation predicates decide every turn: a collinear point has no
 * corner, while an opposite turn would make the boundary concave. A
 * non-adjacent edge check runs first because a star polygon can have the same
 * local turn at every vertex while still crossing itself.
 */
function validateStrictBoundary(
  points: ReadonlyArray<IrregularPoint>
): StrictConvexBoundaryValidation {
  if (points.length < 3) {
    return { message: 'polygon must contain at least three vertices.' }
  }

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]

    if (point === undefined) {
      return { message: 'polygon points must form a closed boundary.' }
    }

  }

  const edges: BoundaryEdge[] = []
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]

    if (start === undefined || end === undefined) {
      return { message: 'polygon points must form a closed boundary.' }
    }

    if (start.x === end.x && start.y === end.y) {
      return { message: 'polygon must not repeat adjacent vertices.' }
    }

    edges.push({ start, end })
  }

  // a consistent turn sign does not imply a simple ring: star boundaries can
  // cross between vertices without changing any local turn
  if (hasSelfIntersection(edges)) {
    return { message: 'polygon must form a simple ring without self-intersections.' }
  }

  let winding: ConvexPolygonWinding | undefined
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length]
    const current = points[index]
    const next = points[(index + 1) % points.length]

    if (previous === undefined || current === undefined || next === undefined) {
      return { message: 'polygon points must form a closed boundary.' }
    }

    // robust orientation keeps the winding decision independent of rounded determinants
    const turn = GeometryPredicates.orientation(previous, current, next)
    if (turn === 0) {
      return { message: 'polygon must not contain collinear vertices.' }
    }

    if (winding === undefined) {
      winding = turn
      continue
    }

    if (turn !== winding) {
      return { message: 'polygon must be strictly convex with one consistent winding.' }
    }
  }

  if (winding === undefined) {
    return { message: 'polygon must have a non-zero area.' }
  }

  return { winding }
}

/**
 * Tests whether non-adjacent edges of an ordered cyclic ring intersect.
 *
 * @param edges directed edges in input order, including the closing edge.
 * @returns `true` when edges cross, overlap, or touch away from their allowed
 * adjacent shared endpoint; otherwise `false`.
 *
 * Adjacent edges are skipped because their shared endpoint is required by the
 * ring topology; the turn and adjacent-vertex checks validate that connection
 * separately.
 */
function hasSelfIntersection(edges: ReadonlyArray<BoundaryEdge>): boolean {
  for (let firstEdgeIndex = 0; firstEdgeIndex < edges.length; firstEdgeIndex += 1) {
    const firstEdge = edges[firstEdgeIndex]
    if (firstEdge === undefined) return true

    for (
      let secondEdgeIndex = firstEdgeIndex + 1;
      secondEdgeIndex < edges.length;
      secondEdgeIndex += 1
    ) {
      if (areAdjacentEdges(firstEdgeIndex, secondEdgeIndex, edges.length)) continue

      const secondEdge = edges[secondEdgeIndex]
      if (secondEdge === undefined) return true

      if (segmentsIntersect(firstEdge, secondEdge)) return true
    }
  }

  return false
}

/**
 * Determines whether two edge indexes are neighbors in a cyclic ring.
 *
 * @param firstEdgeIndex lower edge index in the pair.
 * @param secondEdgeIndex higher edge index in the pair.
 * @param edgeCount number of edges in the closed ring.
 * @returns `true` for consecutive edges, including the first/last pair.
 */
function areAdjacentEdges(
  firstEdgeIndex: number,
  secondEdgeIndex: number,
  edgeCount: number
): boolean {
  return (
    secondEdgeIndex === firstEdgeIndex + 1 ||
    (firstEdgeIndex === 0 && secondEdgeIndex === edgeCount - 1)
  )
}

/**
 * Classifies two finite line segments using robust orientations.
 *
 * @param first first segment in the app's y-up coordinates.
 * @param second second segment in the app's y-up coordinates.
 * @returns `true` for a proper crossing or any endpoint/collinear overlap;
 * otherwise `false`.
 *
 * Zero orientations identify collinear cases, while inclusive coordinate
 * bounds decide whether the collinear point lies on the finite segment. This
 * treats touching as an intersection, which is required for a simple ring.
 */
function segmentsIntersect(first: BoundaryEdge, second: BoundaryEdge): boolean {
  const firstStartTurn = GeometryPredicates.orientation(first.start, first.end, second.start)
  const firstEndTurn = GeometryPredicates.orientation(first.start, first.end, second.end)
  const secondStartTurn = GeometryPredicates.orientation(second.start, second.end, first.start)
  const secondEndTurn = GeometryPredicates.orientation(second.start, second.end, first.end)

  // robust orientation identifies collinearity; coordinate bounds decide whether the
  // collinear point is actually on the finite segment
  if (firstStartTurn === 0 && pointIsOnSegment(second.start, first)) return true
  if (firstEndTurn === 0 && pointIsOnSegment(second.end, first)) return true
  if (secondStartTurn === 0 && pointIsOnSegment(first.start, second)) return true
  if (secondEndTurn === 0 && pointIsOnSegment(first.end, second)) return true

  return firstStartTurn !== firstEndTurn && secondStartTurn !== secondEndTurn
}

/**
 * Checks whether a collinear point lies within a segment's closed bounds.
 *
 * @param point finite point already known to be collinear with `segment`.
 * @param segment finite directed segment in the app's y-up coordinates.
 * @returns `true` when the point is between either endpoint inclusively.
 * Inclusive bounds preserve the simple-ring rule that endpoint touches count
 * as intersections.
 */
function pointIsOnSegment(point: IrregularPoint, segment: BoundaryEdge): boolean {
  return (
    point.x >= Math.min(segment.start.x, segment.end.x) &&
    point.x <= Math.max(segment.start.x, segment.end.x) &&
    point.y >= Math.min(segment.start.y, segment.end.y) &&
    point.y <= Math.max(segment.start.y, segment.end.y)
  )
}
