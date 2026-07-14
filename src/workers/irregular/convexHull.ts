import { IrregularPolygon } from '@shared/irregular/domain.js'
import type { IrregularPoint } from '@shared/irregular/domain.js'

export const ConvexHull = {
  compute
} as const

function compute(points: ReadonlyArray<IrregularPoint>): IrregularPolygon {
  // sort left to right by x; when points share x, sort lower to higher by y
  // example: [(4, 3), (0, 5), (0, 1), (2, 9)] becomes [(0, 1), (0, 5), (2, 9), (4, 3)]
  const sortedPoints = [...points].sort((left, right) => {
    if (left.x !== right.x) return left.x - right.x

    return left.y - right.y
  })

  // collapse only exactly equal source coordinates without introducing a geometric tolerance
  const uniquePoints = deduplicateSortedPoints(sortedPoints)

  // one or two unique points already form their mathematical degenerate hull
  if (uniquePoints.length <= 2) return new IrregularPolygon({ points: uniquePoints })

  // one pass can keep only one side of the outside boundary
  // example: from [(0, 0), (0, 3), (4, 0), (4, 3)], this pass removes (0, 3)
  // it returns [(0, 0), (4, 0), (4, 3)], so the top-left corner is still missing
  const lowerHull = buildHullHalf(uniquePoints)

  // run the same check backwards to find the side missed above
  // the reversed rectangle returns [(4, 3), (0, 3), (0, 0)], which restores the top-left corner
  const upperHull = buildHullHalf([...uniquePoints].reverse())

  // both lists contain the same two end corners, so remove each repeated end before joining them
  // the rectangle becomes [(0, 0), (4, 0), (4, 3), (0, 3)] after this join
  return new IrregularPolygon({
    points: [...lowerHull.slice(0, -1), ...upperHull.slice(0, -1)]
  })
}

function deduplicateSortedPoints(points: ReadonlyArray<IrregularPoint>): IrregularPoint[] {
  const uniquePoints: IrregularPoint[] = []

  for (const point of points) {
    const previousPoint = uniquePoints.at(-1)

    // sorted input makes a duplicate adjacent, so only the previous point needs checking
    if (previousPoint?.x === point.x && previousPoint.y === point.y) continue

    uniquePoints.push(point)
  }

  return uniquePoints
}

/**
 * Builds one side of the rubber-band outline around a point cloud.
 *
 * Input: unique points ordered by x, from left to right. For example,
 * `[(0, 0), (0, 3), (4, 0), (4, 3)]`. With that order this function finds
 * the bottom side. Calling it with the same list reversed finds the top side.
 * The caller joins those two sides into the complete outline.
 *
 * For each candidate point C, A and B are the final two points currently
 * kept by this function. Imagine standing on B after walking from A to B;
 * then turn until you face C. A clockwise turn is a right turn, while a
 * counter-clockwise turn is a left turn.
 *
 * Example of a right turn: A = (0, 0), B = (0, 3), C = (4, 0). Walking from
 * A to B points up. Turning from up to face C points down and right, which is
 * a right turn. B is above the direct edge from A to C, so it cannot be a
 * corner on the bottom side; removing B leaves the correct edge A -> C.
 *
 * Example of a left turn: A = (0, 0), B = (4, 0), C = (4, 3). Walking from A
 * to B points right. Turning from right to face C points up, which is a left
 * turn. B is a real corner of the bottom side, so it stays.
 *
 * If A, B, and C lie on one straight line, B is only an edge-middle point.
 * Removing it leaves the same shape with fewer unnecessary vertices.
 *
 * Output: one open side of the outline, including its two end corners. The
 * caller removes duplicate end corners when joining it with the other side.
 */
function buildHullHalf(points: ReadonlyArray<IrregularPoint>): IrregularPoint[] {
  const hull: IrregularPoint[] = []

  for (const point of points) {
    while (hull.length >= 2) {
      const previousPoint = hull.at(-2)
      const lastPoint = hull.at(-1)

      // the guards keep indexed geometry access explicit without non-null assertions
      if (previousPoint === undefined || lastPoint === undefined) break

      // a right turn means the previous point cannot stay on this outside route
      // it is either inside the rubber band or belongs to the route built by the reverse pass
      // a straight turn means the previous point sits in the middle of an edge and does not need its own vertex
      // discard it so this route stays on the outside and uses only the corners it needs
      if (signedCrossProduct(previousPoint, lastPoint, point) > 0) break

      hull.pop()
    }

    // keep this point because it extends the outside route built so far
    hull.push(point)
  }

  return hull
}

function signedCrossProduct(
  origin: IrregularPoint,
  first: IrregularPoint,
  second: IrregularPoint
): number {
  // turn both origin-to-point edges into arrows that start at the same point
  const firstVectorX = first.x - origin.x
  const firstVectorY = first.y - origin.y
  const secondVectorX = second.x - origin.x
  const secondVectorY = second.y - origin.y

  // x1 * y2 - y1 * x2 measures whether the second arrow points left or right of the first arrow
  // positive means left, negative means right, and zero means both arrows lie on the same straight line
  return firstVectorX * secondVectorY - firstVectorY * secondVectorX
}
