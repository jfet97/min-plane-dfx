import { Effect } from 'effect'
import { IrregularPolygon } from '@shared/irregular/domain.js'
import type { IrregularPoint } from '@shared/irregular/domain.js'
import { GeometryPredicates } from './geometryPredicates.js'
import { IrregularGeometryInputError } from './services.js'

type Winding = -1 | 1

interface OffsetLine {
  readonly point: IrregularPoint
  readonly directionX: number
  readonly directionY: number
}

interface ValidConvexBoundary {
  readonly winding: Winding
}

interface InvalidConvexBoundary {
  readonly message: string
}

export const ConvexPolygonOffset = {
  compute
} as const

/**
 * Builds a sharp outward offset for a strictly convex polygon.
 *
 * Think of every polygon edge as an infinitely long straight line. First move
 * each line outwards by `distanceMm`, perpendicular to the original edge.
 * Then meet each pair of neighbouring shifted lines. Their intersection is
 * the new vertex at that corner.
 *
 * Example: offsetting the counter-clockwise rectangle
 * `[(0, 0), (4, 0), (4, 3), (0, 3)]` by `1` moves its bottom edge to `y = -1`
 * and its left edge to `x = -1`; their intersection becomes `(-1, -1)`.
 * That sharp intersection is a mitered corner: the pointed corner formed where
 * both extended shifted edges meet. This operation does not round corners or
 * cut them with a diagonal bevel.
 *
 * The result preserves the input's winding and omits a repeated closing point,
 * matching `IrregularPolygon`'s representation. It deliberately does not
 * snap, round, or simplify coordinates: those are separate geometry policies.
 */
function compute(
  polygon: IrregularPolygon,
  distanceMm: number
): Effect.Effect<IrregularPolygon, IrregularGeometryInputError> {
  if (!Number.isFinite(distanceMm) || distanceMm < 0) {
    return failInvalidInput('distanceMm must be a finite non-negative millimeter distance.')
  }

  const boundary = validateConvexBoundary(polygon.points)
  if ('message' in boundary) return failInvalidInput(boundary.message)

  // zero distance has a useful deterministic meaning: preserve the validated boundary exactly
  if (distanceMm === 0) {
    return Effect.succeed(new IrregularPolygon({ points: [...polygon.points] }))
  }

  const offsetLines: OffsetLine[] = []
  for (let index = 0; index < polygon.points.length; index += 1) {
    const start = polygon.points[index]
    const end = polygon.points[(index + 1) % polygon.points.length]

    // validation already rejected missing, non-finite, and repeated vertices
    if (start === undefined || end === undefined) {
      return failInvalidInput('polygon points must form a closed boundary.')
    }

    offsetLines.push(createOffsetLine(start, end, distanceMm, boundary.winding))
  }

  const offsetPoints: IrregularPoint[] = []
  for (let index = 0; index < offsetLines.length; index += 1) {
    const previousLine = offsetLines[(index - 1 + offsetLines.length) % offsetLines.length]
    const currentLine = offsetLines[index]

    // create a mitered corner: the sharp point where the two extended shifted edges meet
    if (previousLine === undefined || currentLine === undefined) {
      return failInvalidInput('polygon points must form a closed boundary.')
    }

    const corner = intersectLines(previousLine, currentLine)
    if (corner === undefined) {
      return failInvalidInput(
        'polygon contains an offset corner that cannot be represented reliably with finite coordinates.'
      )
    }

    offsetPoints.push(corner)
  }

  return Effect.succeed(new IrregularPolygon({ points: offsetPoints }))
}

/**
 * Validates the exact shape needed by the edge-shift construction and returns
 * its winding. The final edge is implicit: the last vertex connects back to
 * the first one, so every vertex has a previous and next corner to inspect.
 *
 * A strictly convex boundary turns the same way at every corner. For example,
 * a counter-clockwise rectangle turns left at all four corners. A concave dent
 * makes one turn go the other way, and a collinear edge-middle vertex makes no
 * turn at all. Either case would make the corresponding offset corner
 * ambiguous or unstable, so this operation rejects it rather than guessing.
 */
function validateConvexBoundary(
  points: ReadonlyArray<IrregularPoint>
): ValidConvexBoundary | InvalidConvexBoundary {
  if (points.length < 3) {
    return { message: 'polygon must contain at least three vertices.' }
  }

  let winding: Winding | undefined

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

    // use the robust predicate so winding and convexity do not depend on a rounded determinant sign
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
 * Creates the shifted infinite line for one polygon edge.
 *
 * For a counter-clockwise edge `A -> B`, the polygon interior is on its left,
 * so its outside lies on its right. The perpendicular `(dy, -dx)` points right
 * of `(dx, dy)`, and moving the line in that direction expands the polygon.
 * Clockwise input uses the opposite perpendicular. The original edge direction
 * stays unchanged because only the line's position moves.
 */
function createOffsetLine(
  start: IrregularPoint,
  end: IrregularPoint,
  distanceMm: number,
  winding: Winding
): OffsetLine {
  const directionX = end.x - start.x
  const directionY = end.y - start.y
  const length = Math.hypot(directionX, directionY)

  // validation guarantees a non-zero edge, so this normal points away from the polygon interior
  const outwardScale = (winding * distanceMm) / length
  return {
    point: {
      x: start.x + directionY * outwardScale,
      y: start.y - directionX * outwardScale
    },
    directionX,
    directionY
  }
}

/**
 * Finds one new offset vertex from two neighbouring shifted edge lines.
 *
 * The previous shifted line and current shifted line are extended until they
 * meet; their meeting point replaces the source corner between those edges.
 * They are not treated as finite segments because an outward miter can lie
 * beyond either source edge endpoint. A zero determinant means the two lines
 * became parallel numerically, so returning a made-up corner would be unsafe.
 */
function intersectLines(first: OffsetLine, second: OffsetLine): IrregularPoint | undefined {
  const determinant = first.directionX * second.directionY - first.directionY * second.directionX

  // robust validation proves the original corner is not collinear; still reject a numeric collapse here
  if (!Number.isFinite(determinant) || determinant === 0) return undefined

  const deltaX = second.point.x - first.point.x
  const deltaY = second.point.y - first.point.y
  const firstRatio = (deltaX * second.directionY - deltaY * second.directionX) / determinant
  const x = first.point.x + firstRatio * first.directionX
  const y = first.point.y + firstRatio * first.directionY

  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined

  return { x, y }
}

function failInvalidInput(
  message: string
): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(
    new IrregularGeometryInputError({
      operation: 'offsetConvexPolygon',
      message
    })
  )
}
