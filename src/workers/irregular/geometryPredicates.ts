import { orient2d } from 'robust-predicates'
import type { IrregularPoint } from '@shared/irregular/domain.js'

export type Orientation = -1 | 0 | 1

export const GeometryPredicates = {
  orientation
} as const

/**
 * Classifies the turn from `origin -> first` toward `origin -> second` using
 * an exact-sign orientation predicate. Positive means the second point is on
 * the left in the app's Y-up DXF coordinates, negative means right, and zero
 * means the three points are collinear.
 */
function orientation(
  origin: IrregularPoint,
  first: IrregularPoint,
  second: IrregularPoint
): Orientation {
  const robustResult = orient2d(
    origin.x,
    origin.y,
    first.x,
    first.y,
    second.x,
    second.y
  )

  // robust-predicates uses a y-down screen convention, while DXF geometry uses y-up coordinates
  // invert its sign so positive consistently means a left, counter-clockwise turn in this app
  if (robustResult > 0) return -1
  if (robustResult < 0) return 1
  return 0
}
