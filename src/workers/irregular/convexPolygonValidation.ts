import type { IrregularPoint } from '@shared/irregular/domain.js'
import { GeometryPredicates } from './geometryPredicates.js'

export type ConvexPolygonWinding = -1 | 1

interface ValidStrictConvexBoundary {
  readonly winding: ConvexPolygonWinding
}

interface InvalidStrictConvexBoundary {
  readonly message: string
}

export type StrictConvexBoundaryValidation =
  | ValidStrictConvexBoundary
  | InvalidStrictConvexBoundary

export const ConvexPolygonValidation = {
  validateStrictBoundary
} as const

/**
 * Checks the geometric invariant shared by every v2 collision polygon: at
 * least three finite, distinct vertices that turn consistently around a
 * strictly convex boundary.
 *
 * The final edge is implicit, so the last vertex connects back to the first.
 * Robust orientation predicates decide every turn: a collinear point has no
 * corner, while an opposite turn would make the boundary concave.
 */
function validateStrictBoundary(
  points: ReadonlyArray<IrregularPoint>
): StrictConvexBoundaryValidation {
  if (points.length < 3) {
    return { message: 'polygon must contain at least three vertices.' }
  }

  let winding: ConvexPolygonWinding | undefined
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length]
    const current = points[index]
    const next = points[(index + 1) % points.length]

    if (previous === undefined || current === undefined || next === undefined) {
      return { message: 'polygon points must form a closed boundary.' }
    }

    if (!Number.isFinite(current.x) || !Number.isFinite(current.y)) {
      return { message: 'polygon vertices must have finite coordinates.' }
    }

    if (current.x === next.x && current.y === next.y) {
      return { message: 'polygon must not repeat adjacent vertices.' }
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
